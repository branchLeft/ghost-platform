'use strict';

const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');

const {
  quarantineBytes,
  quarantinedBytesMatch,
  writeFileAtomicSync,
  isRefused,
  sealRefusal,
} = require('./quarantine');

// Incidental, like the verdict budget in checks.js: how often a held digest
// is re-asked, not whether it is re-asked at all.
const DEFAULT_RETRY_INTERVAL_MS = 2000;
// A ceiling on the INTERVAL, never on how long a hold lives -- the design
// means held forever if the verdict never resolves. This bounds the polling rate
// during a prolonged outage without ever giving up on an item.
const DEFAULT_MAX_RETRY_INTERVAL_MS = 60_000;
// A bound on consecutive retries that FAIL (a throw from the filesystem or a
// promote/refuse callback), not on retries that are merely still waiting for
// a verdict. Past it the hold is stuck: kept, never promoted, and logged.
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;
// Sidecar suffix recording which target paths are waiting on a digest, so a
// restart can tell a still-pending hold apart from a permanently quarantined
// refusal -- both live at `<quarantinePath>/<digest>`, but only a hold has
// one of these next to it.
const HOLDS_SUFFIX = '.holds.json';
// Every stuck hold is logged with this prefix, at the moment it sticks and
// again on every restart that finds it, so a log search or alert has one
// fixed string to match.
const STUCK_LOG_PREFIX = 'ScanningStorageAdapter: hold stuck';

// Runs every blocking check against a buffer and returns the first
// non-allow decision, or {decision: 'allow'} once every check clears it.
// Shared by the synchronous scan and a held item's later retries, so a
// retry is judged by exactly the policy a live upload would be.
async function evaluate(checks, policy, buffer) {
  for (const check of checks) {
    const verdict = await check.run({ buffer });
    const decision = policy.decide(verdict, { kind: check.kind });
    if (decision !== 'allow') {
      return { decision, verdict };
    }
  }
  return { decision: 'allow', verdict: null };
}

function sidecarPath(quarantinePath, digest) {
  return path.join(quarantinePath, `${digest}${HOLDS_SUFFIX}`);
}

// Sidecar shape: {"owners": {"<owner>": ["<targetPath>", ...]},
// "stuck": {"<owner>": {"reason": "..."}}}. Ghost constructs one decorator
// per storage feature, and a deployment gives all three the same
// quarantinePath, so one digest's sidecar can be shared by several
// registries in one process. Each registry reads and writes only its own
// owner's entries, and only the last owner to release a digest removes the
// bytes. Returns null when there is no sidecar; throws when there is one
// this code cannot attribute to an owner.
function readSidecarSync(file) {
  let raw;
  try {
    raw = fsSync.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !parsed.owners ||
    typeof parsed.owners !== 'object' ||
    Array.isArray(parsed.owners)
  ) {
    throw new Error('hold sidecar has no owners map');
  }
  return parsed;
}

// Tracks bytes accepted with no verdict yet (the hold branch's asynchronous route).
// There is no real verdict channel yet (it is a separate story in a
// separate repo), so "a later verdict arrives" can only mean one thing
// this decorator can observe: the same in-process VerdictClient answering
// differently on a later call. This registry polls for that, at a cost
// this component owns rather than the upload -- an author who is never
// told to wait must not become a request that never resolves either.
//
// The quarantine directory is the only source of truth. Nothing about a
// pending hold lives only in this process's memory: the bytes are on disk
// from the moment they are held (quarantineBytes, same as a refusal), and
// which target paths are waiting on them is a JSON sidecar next to that
// file. A process restart -- a deploy, a crash, an OOM kill, a health-check
// restart -- loses only the in-memory retry timers, which resumeFromQuarantine
// rebuilds from disk. The upload's own bytes are never held in memory for
// longer than a single retry tick: #retry re-reads them from quarantine
// every time rather than keeping a buffer resident for the item's whole
// (potentially unbounded) lifetime.
//
// A refusal by any owner is final for every owner: the refusal record next
// to the bytes (quarantine.js) is checked before every promotion, and bytes
// it names are never deleted.
class HoldRegistry {
  constructor({
    checks,
    policy,
    quarantinePath,
    owner,
    computeDigest,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    maxRetryIntervalMs = DEFAULT_MAX_RETRY_INTERVAL_MS,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
    logger = console,
  }) {
    // Without an owner, a registry resuming after a restart would pick up
    // every feature's holds from a shared quarantine directory and promote
    // them through its own wrapped adapter -- into the wrong served tree.
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new Error('HoldRegistry requires an owner naming where its holds promote to');
    }
    // Without it, bytes read back from quarantine could not be checked
    // against the digest they are filed under, and a truncated file would be
    // judged and promoted as if it were the upload.
    if (typeof computeDigest !== 'function') {
      throw new Error('HoldRegistry requires computeDigest(buffer) to verify quarantined bytes');
    }
    this.owner = owner;
    this.checks = checks;
    this.policy = policy;
    this.quarantinePath = quarantinePath;
    this.computeDigest = computeDigest;
    this.retryIntervalMs = retryIntervalMs;
    this.maxRetryIntervalMs = maxRetryIntervalMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.logger = logger;
    // digest -> { holds: [{targetPath, onAllow, onRefuse}], timer, intervalMs, failures }
    //
    // Keyed by digest, not by hold: the same content can be held twice from
    // two different calls before either resolves -- an unresized-derivative
    // request re-saving the exact bytes of a still-unverified original is a
    // real case, seen with resize disabled, not a contrived one. Both calls
    // share one verdict and one retry loop, but each keeps its own
    // targetPath and its own promote/refuse callback, so every place that
    // content was ever promised to a caller is written on promotion.
    this.entries = new Map();
    // digest -> reason. Terminal for this process; persisted in the sidecar
    // so a restart does not quietly start the loop again.
    this.stuck = new Map();
  }

  isPending(digest) {
    return this.entries.has(digest);
  }

  isStuck(digest) {
    return this.stuck.has(digest);
  }

  stuckDigests() {
    return [...this.stuck.entries()].map(([digest, reason]) => ({ digest, reason }));
  }

  // Quarantines the bytes (exactly as a refusal does) and starts
  // polling if this digest is not already held. `onAllow(buffer)` and
  // `onRefuse()` are the caller's own backend-specific promotion/cleanup;
  // this registry owns only the bookkeeping and the retry loop, never
  // storage-adapter specifics.
  async hold(digest, buffer, { targetPath, onAllow, onRefuse }) {
    if (this.#joinExisting(digest, { targetPath, onAllow, onRefuse })) return;

    // Bytes already on disk that match their digest are left alone (another
    // feature may be reading them); anything else -- nothing yet, or a copy
    // that does not hash to its name -- is replaced by the bytes in hand.
    if (!(await quarantinedBytesMatch(this.quarantinePath, digest, this.computeDigest))) {
      await quarantineBytes(this.quarantinePath, digest, buffer);
    }

    // A concurrent hold() of the same digest may have registered while this
    // one was writing.
    if (this.#joinExisting(digest, { targetPath, onAllow, onRefuse })) return;

    if (this.stuck.has(digest)) {
      // Terminal: the new target is recorded so an operator clearing the
      // stuck state gets it back on restart, but nothing retries it now.
      const sidecar = readSidecarSync(sidecarPath(this.quarantinePath, digest));
      const targets = (sidecar && sidecar.owners[this.owner]) || [];
      this.#writeOwnTargets(digest, [...targets, targetPath]);
      this.logger.error(
        `${STUCK_LOG_PREFIX} for ${digest} (owner ${this.owner}); a new upload of the same bytes stays held and unpromoted`
      );
      return;
    }

    this.#writeOwnTargets(digest, [targetPath]);
    const entry = {
      holds: [{ targetPath, onAllow, onRefuse }],
      timer: null,
      intervalMs: this.retryIntervalMs,
      failures: 0,
    };
    this.entries.set(digest, entry);
    this.#scheduleRetry(digest);
  }

  #joinExisting(digest, hold) {
    const existing = this.entries.get(digest);
    if (!existing) return false;
    existing.holds.push(hold);
    this.#writeOwnTargets(
      digest,
      existing.holds.map((h) => h.targetPath)
    );
    return true;
  }

  // Restart-safety: called once, synchronously, from the adapter's own
  // constructor, before it can serve a single request -- see
  // scanning-storage.js. `buildCallbacks(targetPath)` must return the same
  // shape `hold()`'s caller does; it is how this registry, which knows
  // nothing about a wrapped storage adapter, gets a promote function back.
  //
  // Synchronous on purpose: this only re-derives which digests are pending
  // and schedules their first retry. The bytes themselves are never read
  // here -- #retry reads them fresh from quarantine on its own first tick,
  // exactly as it does on every later one, so a resumed hold costs no more
  // memory at startup than a fresh one costs per poll.
  resumeFromQuarantine(buildCallbacks) {
    let names;
    try {
      names = fsSync.readdirSync(this.quarantinePath);
    } catch {
      return; // no quarantine directory yet -- nothing to resume
    }

    for (const name of names) {
      if (!name.endsWith(HOLDS_SUFFIX)) continue;
      const digest = name.slice(0, -HOLDS_SUFFIX.length);
      if (this.entries.has(digest)) continue;
      if (!fsSync.existsSync(path.join(this.quarantinePath, digest))) {
        this.logger.error(
          `ScanningStorageAdapter: found a hold sidecar with no bytes behind it for ${digest}; skipping`
        );
        continue;
      }

      let targetPaths;
      let stuck;
      try {
        const sidecar = readSidecarSync(path.join(this.quarantinePath, name));
        if (!sidecar || !Object.prototype.hasOwnProperty.call(sidecar.owners, this.owner)) {
          continue; // another feature's hold, promoted by that feature's own registry
        }
        targetPaths = sidecar.owners[this.owner];
        if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
          throw new Error('empty or malformed sidecar');
        }
        stuck = sidecar.stuck && sidecar.stuck[this.owner];
      } catch (err) {
        this.logger.error(
          `ScanningStorageAdapter: could not read the hold sidecar for ${digest}; leaving it held but unresumed`,
          err
        );
        continue;
      }

      if (stuck) {
        const reason = stuck.reason || 'unknown';
        this.stuck.set(digest, reason);
        this.logger.error(
          `${STUCK_LOG_PREFIX} for ${digest} (owner ${this.owner}): ${reason}; not resumed`
        );
        continue;
      }

      const holds = targetPaths.map((targetPath) => ({
        targetPath,
        ...buildCallbacks(targetPath),
      }));
      this.entries.set(digest, {
        holds,
        timer: null,
        intervalMs: this.retryIntervalMs,
        failures: 0,
      });
      this.#scheduleRetry(digest);
    }
  }

  #scheduleRetry(digest) {
    const entry = this.entries.get(digest);
    if (!entry) return;
    const timer = setTimeout(() => {
      this.#retry(digest).catch((err) => this.#onRetryFailure(digest, err));
    }, entry.intervalMs);
    // Never keeps a test runner, or a Ghost worker with nothing else to
    // do, alive on this timer alone.
    if (typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
  }

  // A verdict that is genuinely still pending never reaches here --
  // evaluate() never throws (checks.js's own run() catches internally and
  // resolves to 'unavailable'). Anything that does is a real fault in a
  // promote/refuse callback or the filesystem. Promotion writes are
  // idempotent (content-addressed, deterministic target), so a bounded
  // number of backed-off repeats is safe; an unbounded one would hammer a
  // broken backend forever and hide the fault in a stream of identical lines.
  #onRetryFailure(digest, err) {
    const entry = this.entries.get(digest);
    if (!entry) return;
    entry.failures += 1;
    if (entry.failures >= this.maxConsecutiveFailures) {
      this.#markStuck(
        digest,
        `${entry.failures} consecutive retries failed; last error: ${err && err.message}`,
        err
      );
      return;
    }
    this.logger.error(
      `ScanningStorageAdapter: hold retry failed for ${digest} (${entry.failures} of ${this.maxConsecutiveFailures})`,
      err
    );
    entry.intervalMs = Math.min(entry.intervalMs * 2, this.maxRetryIntervalMs);
    this.#scheduleRetry(digest);
  }

  async #retry(digest) {
    // Always present: a retry is only ever scheduled for a digest that is
    // still in this map, and nothing removes it except #forget, which
    // clears the very timer that would fire this retry.
    const entry = this.entries.get(digest);

    if (isRefused(this.quarantinePath, digest)) {
      await this.#resolveRefused(digest, entry);
      return;
    }

    const buffer = await fs.readFile(path.join(this.quarantinePath, digest));
    if (this.computeDigest(buffer) !== digest) {
      // Bytes that do not hash to their name are not the upload: judging
      // them would put a verdict on the wrong content, and retrying cannot
      // repair them. Only a fresh upload of the real bytes can (hold()).
      this.#markStuck(digest, 'the quarantined bytes do not match their digest');
      return;
    }

    const { decision, verdict } = await evaluate(this.checks, this.policy, buffer);

    if (decision === 'refuse') {
      // Sealed before any callback runs, so every other owner's next
      // retry sees the refusal even if this one fails partway.
      await sealRefusal(this.quarantinePath, digest, buffer, verdict, this.computeDigest);
      await this.#resolveRefused(digest, entry);
      return;
    }

    if (decision === 'allow') {
      for (const hold of entry.holds) {
        // Another owner can seal a refusal while an earlier promotion in
        // this loop is awaiting its backend.
        if (isRefused(this.quarantinePath, digest)) {
          await this.#resolveRefused(digest, entry);
          return;
        }
        await hold.onAllow(buffer);
      }
      this.#forget(digest);
      this.#release(digest, { keepBytes: false });
      return;
    }

    // Still 'hold' (or an out-of-scope 'flag', which this decorator never
    // produces through SafetyPolicy but must not crash a background retry
    // on): back off the interval, never the lifetime.
    entry.failures = 0;
    entry.intervalMs = Math.min(entry.intervalMs * 2, this.maxRetryIntervalMs);
    this.#scheduleRetry(digest);
  }

  // The bytes stay: they are the sealed record, indistinguishable from a
  // synchronous refusal. Nothing was ever written to a served location for
  // a hold, so onRefuse has nothing of this registry's to undo.
  async #resolveRefused(digest, entry) {
    for (const hold of entry.holds) {
      await hold.onRefuse();
    }
    this.#forget(digest);
    this.#release(digest, { keepBytes: true });
  }

  #markStuck(digest, reason, err) {
    this.#forget(digest);
    this.stuck.set(digest, reason);
    const file = sidecarPath(this.quarantinePath, digest);
    try {
      const sidecar = readSidecarSync(file) || { owners: {} };
      sidecar.stuck = { ...(sidecar.stuck || {}), [this.owner]: { reason } };
      writeFileAtomicSync(file, JSON.stringify(sidecar));
    } catch (writeErr) {
      this.logger.error(
        `ScanningStorageAdapter: could not persist the stuck state for ${digest}`,
        writeErr
      );
    }
    this.logger.error(
      `${STUCK_LOG_PREFIX} for ${digest} (owner ${this.owner}): ${reason}; it will not be promoted`,
      err
    );
  }

  // Synchronous read-modify-write, so no other registry sharing this
  // sidecar can interleave between the read and the write. An existing
  // sidecar this code cannot attribute throws rather than being
  // overwritten: it may be someone's pending hold.
  #writeOwnTargets(digest, targetPaths) {
    const file = sidecarPath(this.quarantinePath, digest);
    const sidecar = readSidecarSync(file) || { owners: {} };
    sidecar.owners[this.owner] = targetPaths;
    writeFileAtomicSync(file, JSON.stringify(sidecar));
  }

  // Drops this registry's entry from the sidecar. Only when no other owner
  // is still waiting on the digest are the sidecar and (for a promotion)
  // the bytes removed -- another feature's registry re-reads those bytes
  // on its own next retry. Bytes a refusal record names are never removed,
  // whoever releases last. Otherwise best-effort: promotion makes the
  // object backup-eligible from its real served location, so a leftover
  // file here is untidy, never unsafe.
  #release(digest, { keepBytes }) {
    const file = sidecarPath(this.quarantinePath, digest);
    try {
      const sidecar = readSidecarSync(file) || { owners: {} };
      delete sidecar.owners[this.owner];
      if (sidecar.stuck) delete sidecar.stuck[this.owner];
      if (Object.keys(sidecar.owners).length > 0) {
        writeFileAtomicSync(file, JSON.stringify(sidecar));
        return;
      }
      if (!keepBytes && !isRefused(this.quarantinePath, digest)) {
        fsSync.rmSync(path.join(this.quarantinePath, digest), { force: true });
      }
      fsSync.rmSync(file, { force: true });
    } catch (err) {
      this.logger.error(`ScanningStorageAdapter: quarantine cleanup failed for ${digest}`, err);
    }
  }

  #forget(digest) {
    const entry = this.entries.get(digest);
    this.entries.delete(digest);
    if (entry && entry.timer) clearTimeout(entry.timer);
  }

  // Test/shutdown hygiene only: stops every pending retry without
  // resolving any of them. Never called from production code paths.
  stopAll() {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
  }
}

module.exports = {
  HoldRegistry,
  evaluate,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_MAX_RETRY_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  HOLDS_SUFFIX,
  STUCK_LOG_PREFIX,
};

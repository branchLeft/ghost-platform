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
  releaseBytes,
  sweepReleasing,
  sweepOrphans,
  HOLDS_SUFFIX,
} = require('./quarantine');

// Incidental, like the verdict budget in checks.js: how often a held digest
// is re-asked, not whether it is re-asked at all.
const DEFAULT_RETRY_INTERVAL_MS = 2000;
// Incidental, like the retry interval: how long a write to the wrapped
// adapter may stay unsettled before it counts as failed. It only turns
// "waits forever" into "failed", never changes what is written or allowed.
const DEFAULT_WRITE_TIMEOUT_MS = 60_000;
// The largest delay setTimeout honours; anything above it fires after 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// A ceiling on the INTERVAL, never on how long a hold lives -- the design
// means held forever if the verdict never resolves. This bounds the polling rate
// during a prolonged outage without ever giving up on an item.
const DEFAULT_MAX_RETRY_INTERVAL_MS = 60_000;
// A bound on consecutive retries that FAIL (a throw from the filesystem or a
// promote/refuse callback), not on retries that are merely still waiting for
// a verdict. Past it the hold is stuck: kept, no further promotion attempted, and logged.
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;
// How old quarantined bytes with no sidecar and no refusal record must be
// before the sweep removes them. It has to dwarf the write timeout and any
// pause between a hold's two writes, so no live writer is ever mistaken for
// a crashed one; see the README's "Orphaned bytes".
const DEFAULT_ORPHAN_MIN_AGE_MS = 10 * 60_000;
// How often the sweep runs after start-up. Incidental: a shorter interval
// only finds an orphan sooner, since the minimum age is what protects writers.
const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;
// Every stuck hold is logged with this prefix, at the moment it sticks and
// again on every restart that finds it, so a log search or alert has one
// fixed string to match.
const STUCK_LOG_PREFIX = 'ScanningStorageAdapter: hold stuck';
// Logged when an upload request's own write to the wrapped adapter times out.
const REQUEST_WRITE_TIMEOUT_LOG_PREFIX = 'ScanningStorageAdapter: request write timed out';

// The errors withWriteTimeout raised, so a caller can tell its timeout from
// a storage error whose message happens to read the same.
const writeTimeoutErrors = new WeakSet();

// A budget that is not a finite number in (0, 2147483647] would make
// setTimeout fire at once or never, so it falls back to the default.
function resolveTimerMs(value, fallback) {
  const usable =
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS;
  return usable ? value : fallback;
}

function resolveWriteTimeoutMs(value) {
  return resolveTimerMs(value, DEFAULT_WRITE_TIMEOUT_MS);
}

// Rejects once `ms` pass with the write still unsettled. The write itself
// cannot be cancelled and may still land later.
function withWriteTimeout(promise, ms) {
  const write = Promise.resolve(promise);
  write.catch(() => {});
  let timer;
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`write timed out after ${ms} ms`);
      writeTimeoutErrors.add(err);
      reject(err);
    }, ms);
  });
  return Promise.race([write, timedOut]).finally(() => clearTimeout(timer));
}

function isWriteTimeoutError(err) {
  return writeTimeoutErrors.has(err);
}

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

// Tracks bytes accepted with no verdict yet. The quarantine directory, not
// this process's memory, is the source of truth, and a refusal by any owner
// is final for every owner: see the README's "The hold branch".
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
    writeTimeoutMs,
    orphanMinAgeMs,
    orphanSweepIntervalMs,
    now = Date.now,
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
    this.writeTimeoutMs = resolveWriteTimeoutMs(writeTimeoutMs);
    // A non-positive or non-numeric age would make the sweep treat a live
    // writer's bytes as abandoned, so it falls back to the default.
    this.orphanMinAgeMs = resolveTimerMs(orphanMinAgeMs, DEFAULT_ORPHAN_MIN_AGE_MS);
    this.orphanSweepIntervalMs = resolveTimerMs(
      orphanSweepIntervalMs,
      DEFAULT_ORPHAN_SWEEP_INTERVAL_MS
    );
    this.now = now;
    this.orphanSweepTimer = null;
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
      await this.#reconfirmBytes(digest, buffer);
      this.logger.error(
        `${STUCK_LOG_PREFIX} for ${digest} (owner ${this.owner}); a new upload of the same bytes stays held and unpromoted`
      );
      return;
    }

    this.#writeOwnTargets(digest, [targetPath]);
    await this.#reconfirmBytes(digest, buffer);
    // Another hold() of the same digest may have registered during the
    // reconfirm; this one joins it rather than replacing its entry.
    if (this.#joinExisting(digest, { targetPath, onAllow, onRefuse })) return;
    const entry = {
      holds: [{ targetPath, onAllow, onRefuse }],
      timer: null,
      intervalMs: this.retryIntervalMs,
      failures: 0,
    };
    entry.sinceMs = Date.now();
    this.entries.set(digest, entry);
    this.#scheduleRetry(digest);
  }

  // The orphan sweep may have removed bytes this hold found already on disk
  // and so did not write: it moves them aside before it looks for a sidecar.
  // Once the sidecar exists no sweep removes them, so a check after the
  // sidecar write settles it: put the bytes back if they are gone.
  async #reconfirmBytes(digest, buffer) {
    if (!(await quarantinedBytesMatch(this.quarantinePath, digest, this.computeDigest))) {
      await quarantineBytes(this.quarantinePath, digest, buffer);
    }
  }

  // What the metrics read: how many holds wait for a verdict, since when the
  // oldest has waited, and how many gave up retrying.
  heldSummary() {
    let oldestSinceMs = null;
    for (const entry of this.entries.values()) {
      if (oldestSinceMs === null || entry.sinceMs < oldestSinceMs) oldestSinceMs = entry.sinceMs;
    }
    return { count: this.entries.size, oldestSinceMs, stuck: this.stuck.size };
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

  // Called synchronously from the adapter's constructor, before it can serve
  // a request. `buildCallbacks(targetPath)` returns what hold()'s caller
  // passes. Bytes are not read here; #retry reads them on its first tick.
  resumeFromQuarantine(buildCallbacks) {
    sweepReleasing(this.quarantinePath, this.computeDigest, this.logger);
    this.#sweepOrphansLogged();
    this.#startOrphanSweeps();
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
        sinceMs: this.#heldSinceMs(digest),
      });
      this.#scheduleRetry(digest);
    }
  }

  // Never throws: it runs from the adapter's constructor and from a timer,
  // and a failed sweep must neither stop start-up nor kill the process.
  #sweepOrphansLogged() {
    try {
      sweepOrphans(this.quarantinePath, {
        minAgeMs: this.orphanMinAgeMs,
        now: this.now,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.error('ScanningStorageAdapter: orphan sweep failed', err);
    }
  }

  #startOrphanSweeps() {
    if (this.orphanSweepTimer) return;
    this.orphanSweepTimer = setInterval(
      () => this.#sweepOrphansLogged(),
      this.orphanSweepIntervalMs
    );
    // Never keeps a test runner, or a Ghost worker with nothing else to
    // do, alive on this timer alone.
    this.orphanSweepTimer.unref();
  }

  // A resumed hold has no in-memory start time. The quarantined bytes are
  // written once, when the upload is first held, so their mtime is when the
  // wait began; the sidecar is rewritten whenever a target joins.
  #heldSinceMs(digest) {
    try {
      return fsSync.statSync(path.join(this.quarantinePath, digest)).mtimeMs;
    } catch {
      return Date.now();
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
      // repair them. A stuck hold stays stuck until an operator clears it
      // (README, "Stuck holds"); a later upload only rewrites the bytes.
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
        await withWriteTimeout(hold.onAllow(buffer), this.writeTimeoutMs);
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
      `${STUCK_LOG_PREFIX} for ${digest} (owner ${this.owner}): ${reason}; no further promotion will be attempted`,
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
  // even by another process (releaseBytes). Otherwise best-effort: a
  // leftover file here is untidy, never unsafe.
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
      if (!keepBytes) releaseBytes(this.quarantinePath, digest);
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
    clearInterval(this.orphanSweepTimer);
    this.orphanSweepTimer = null;
  }
}

module.exports = {
  HoldRegistry,
  evaluate,
  withWriteTimeout,
  isWriteTimeoutError,
  resolveWriteTimeoutMs,
  DEFAULT_WRITE_TIMEOUT_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_MAX_RETRY_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_ORPHAN_MIN_AGE_MS,
  DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  HOLDS_SUFFIX,
  STUCK_LOG_PREFIX,
  REQUEST_WRITE_TIMEOUT_LOG_PREFIX,
};

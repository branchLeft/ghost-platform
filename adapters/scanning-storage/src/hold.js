'use strict';

const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');

const { quarantineBytes } = require('./quarantine');

// Incidental, like the verdict budget in checks.js: how often a held digest
// is re-asked, not whether it is re-asked at all.
const DEFAULT_RETRY_INTERVAL_MS = 2000;
// A ceiling on the INTERVAL, never on how long a hold lives -- the design
// means held forever if the verdict never resolves. This bounds the polling rate
// during a prolonged outage without ever giving up on an item.
const DEFAULT_MAX_RETRY_INTERVAL_MS = 60_000;
// Sidecar suffix recording which target paths are waiting on a digest, so a
// restart can tell a still-pending hold apart from a permanently quarantined
// refusal -- both live at `<quarantinePath>/<digest>`, but only a hold has
// one of these next to it.
const HOLDS_SUFFIX = '.holds.json';

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
class HoldRegistry {
  constructor({
    checks,
    policy,
    quarantinePath,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    maxRetryIntervalMs = DEFAULT_MAX_RETRY_INTERVAL_MS,
    logger = console,
  }) {
    this.checks = checks;
    this.policy = policy;
    this.quarantinePath = quarantinePath;
    this.retryIntervalMs = retryIntervalMs;
    this.maxRetryIntervalMs = maxRetryIntervalMs;
    this.logger = logger;
    // digest -> { holds: [{targetPath, onAllow, onRefuse}], timer, intervalMs }
    //
    // Keyed by digest, not by hold: the same content can be held twice from
    // two different calls before either resolves -- an unresized-derivative
    // request re-saving the exact bytes of a still-unverified original is a
    // real case, seen with resize disabled, not a contrived one. Both calls
    // share one verdict and one retry loop, but each keeps its own
    // targetPath and its own promote/refuse callback, so every place that
    // content was ever promised to a caller is written on promotion.
    this.entries = new Map();
  }

  isPending(digest) {
    return this.entries.has(digest);
  }

  // Quarantines the bytes (exactly as a refusal does) and starts
  // polling if this digest is not already held. `onAllow(buffer)` and
  // `onRefuse()` are the caller's own backend-specific promotion/cleanup;
  // this registry owns only the bookkeeping and the retry loop, never
  // storage-adapter specifics.
  async hold(digest, buffer, { targetPath, onAllow, onRefuse }) {
    const existing = this.entries.get(digest);
    if (existing) {
      existing.holds.push({ targetPath, onAllow, onRefuse });
      await this.#writeSidecar(
        digest,
        existing.holds.map((h) => h.targetPath)
      );
      return;
    }

    await quarantineBytes(this.quarantinePath, digest, buffer);
    await this.#writeSidecar(digest, [targetPath]);
    const entry = {
      holds: [{ targetPath, onAllow, onRefuse }],
      timer: null,
      intervalMs: this.retryIntervalMs,
    };
    this.entries.set(digest, entry);
    this.#scheduleRetry(digest);
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
      try {
        targetPaths = JSON.parse(fsSync.readFileSync(path.join(this.quarantinePath, name), 'utf8'));
        if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
          throw new Error('empty or malformed sidecar');
        }
      } catch (err) {
        this.logger.error(
          `ScanningStorageAdapter: could not read the hold sidecar for ${digest}; leaving it held but unresumed`,
          err
        );
        continue;
      }

      const holds = targetPaths.map((targetPath) => ({
        targetPath,
        ...buildCallbacks(targetPath),
      }));
      this.entries.set(digest, { holds, timer: null, intervalMs: this.retryIntervalMs });
      this.#scheduleRetry(digest);
    }
  }

  #scheduleRetry(digest) {
    const entry = this.entries.get(digest);
    if (!entry) return;
    const timer = setTimeout(() => {
      this.#retry(digest).catch((err) => {
        // A verdict that is genuinely still pending never reaches here --
        // evaluate() never throws (checks.js's own run() catches
        // internally and resolves to 'unavailable'). Anything that does is
        // a real bug in a promote/refuse callback, or the filesystem, and
        // staying silent about it was its own finding: log it, then retry
        // anyway. Promotion writes are idempotent (content-addressed,
        // deterministic target), so losing a hold over a logged, retryable
        // failure would be worse than repeating it.
        this.logger.error(`ScanningStorageAdapter: hold retry failed for ${digest}`, err);
        this.#scheduleRetry(digest);
      });
    }, entry.intervalMs);
    // Never keeps a test runner, or a Ghost worker with nothing else to
    // do, alive on this timer alone.
    if (typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
  }

  async #retry(digest) {
    // Always present: a retry is only ever scheduled for a digest that is
    // still in this map, and nothing removes it except #forget, which
    // clears the very timer that would fire this retry.
    const entry = this.entries.get(digest);
    const buffer = await fs.readFile(path.join(this.quarantinePath, digest));

    const { decision } = await evaluate(this.checks, this.policy, buffer);

    if (decision === 'allow') {
      for (const hold of entry.holds) {
        await hold.onAllow(buffer);
      }
      this.#forget(digest);
      await this.#removeQuarantine(digest, { keepBytes: false });
      return;
    }

    if (decision === 'refuse') {
      // A later match moves it to quarantine and applies the policy,
      // exactly as a synchronous match would -- it is already quarantined
      // (hold() did that), so what is left is backend cleanup and dropping
      // the sidecar. The bytes themselves stay: they are now the permanent
      // refused record, indistinguishable from a synchronous refusal.
      for (const hold of entry.holds) {
        await hold.onRefuse();
      }
      this.#forget(digest);
      await this.#removeQuarantine(digest, { keepBytes: true });
      return;
    }

    // Still 'hold' (or an out-of-scope 'flag', which this decorator never
    // produces through SafetyPolicy but must not crash a background retry
    // on): back off the interval, never the lifetime.
    entry.intervalMs = Math.min(entry.intervalMs * 2, this.maxRetryIntervalMs);
    this.#scheduleRetry(digest);
  }

  async #writeSidecar(digest, targetPaths) {
    await fs.writeFile(sidecarPath(this.quarantinePath, digest), JSON.stringify(targetPaths));
  }

  async #removeQuarantine(digest, { keepBytes }) {
    // Best-effort: promotion makes the object backup-eligible from its
    // real served location and a refusal's own bytes are the permanent
    // record either way, so a leftover file here is untidy, never unsafe.
    try {
      if (!keepBytes) {
        await fs.rm(path.join(this.quarantinePath, digest), { force: true });
      }
      await fs.rm(sidecarPath(this.quarantinePath, digest), { force: true });
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
};

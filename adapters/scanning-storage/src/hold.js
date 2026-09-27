'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const { quarantineBytes } = require('./quarantine');

// Incidental, like the verdict budget in checks.js: how often a held digest
// is re-asked, not whether it is re-asked at all.
const DEFAULT_RETRY_INTERVAL_MS = 2000;

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

// Tracks bytes accepted with no verdict yet (D34's asynchronous branch).
// There is no real verdict channel yet (it is a separate story in a
// separate repo), so "a later verdict arrives" can only mean one thing
// this decorator can observe: the same in-process VerdictClient answering
// differently on a later call. This registry polls for that, at a cost
// this component owns rather than the upload -- an author who is never
// told to wait must not become a request that never resolves either.
class HoldRegistry {
  constructor({ checks, policy, quarantinePath, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS }) {
    this.checks = checks;
    this.policy = policy;
    this.quarantinePath = quarantinePath;
    this.retryIntervalMs = retryIntervalMs;
    // digest -> { buffer, holds: [{urlKey, pathKey, onAllow, onRefuse}], timer }
    //
    // Keyed by digest, not by hold: the same content can be held twice from
    // two different calls before either resolves -- an unresized-derivative
    // request re-saving the exact bytes of a still-unverified original is a
    // real case, seen with resize disabled, not a contrived one. Both calls
    // share one verdict and one retry loop, but each keeps its own
    // urlKey/pathKey and its own promote/refuse callback, so every place
    // that content was ever returned to a caller is unmasked -- or is not
    // -- together.
    this.entries = new Map();
    // A digest that is refused after having been held is never removed from
    // these -- the control case is "a held object that never clears is
    // never served", and a refusal is a hold that clears to nothing.
    this.urlKeys = new Set();
    this.pathKeys = new Set();
  }

  isHeldUrl(key) {
    return typeof key === 'string' && this.urlKeys.has(key);
  }

  // A path key is compared with leading slashes stripped: Ghost's own
  // internal callers are not consistent about a leading `/` on what is
  // otherwise the same storage-relative path (measured against a real
  // Ghost 6.55.0 -- urlToPath()'s own output omits it, handle-image-sizes'
  // read() call includes it), and a held digest must not be missed over a
  // character neither side treats as meaningful.
  isHeldPath(key) {
    return typeof key === 'string' && this.pathKeys.has(normalizePathKey(key));
  }

  // Quarantines the bytes (exactly as a refusal does) and starts
  // polling if this digest is not already held. `onAllow(buffer)` and
  // `onRefuse()` are the caller's own backend-specific promotion/cleanup;
  // this registry owns only the bookkeeping and the retry loop, never
  // storage-adapter specifics.
  async hold(digest, buffer, { urlKey, pathKey, onAllow, onRefuse }) {
    const normalizedPathKey = pathKey ? normalizePathKey(pathKey) : undefined;
    const existing = this.entries.get(digest);
    if (existing) {
      existing.holds.push({ urlKey, pathKey: normalizedPathKey, onAllow, onRefuse });
      this.urlKeys.add(urlKey);
      if (normalizedPathKey) this.pathKeys.add(normalizedPathKey);
      return;
    }

    await quarantineBytes(this.quarantinePath, digest, buffer);
    const entry = {
      buffer,
      holds: [{ urlKey, pathKey: normalizedPathKey, onAllow, onRefuse }],
      timer: null,
    };
    this.entries.set(digest, entry);
    this.urlKeys.add(urlKey); // every caller has a URL to return -- see scanning-storage.js
    if (normalizedPathKey) this.pathKeys.add(normalizedPathKey);
    this.#scheduleRetry(digest);
  }

  #scheduleRetry(digest) {
    const entry = this.entries.get(digest);
    if (!entry) return;
    const timer = setTimeout(() => {
      this.#retry(digest).catch(() => {
        // A retry that throws must not kill the process a real Ghost
        // depends on; the item simply stays held and is tried again.
        this.#scheduleRetry(digest);
      });
    }, this.retryIntervalMs);
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

    const { decision } = await evaluate(this.checks, this.policy, entry.buffer);

    if (decision === 'allow') {
      for (const hold of entry.holds) {
        await hold.onAllow(entry.buffer);
      }
      // Unmasking is the property that matters and must not wait on
      // housekeeping: the quarantine copy is now redundant with the real,
      // served one, but leaving it a little longer is untidy, never unsafe.
      this.#forget(digest, entry, { unmask: true });
      await this.#quarantineCleanup(digest);
      return;
    }

    if (decision === 'refuse') {
      // A later match moves it to quarantine and applies the policy,
      // exactly as a synchronous match would -- it is already quarantined
      // (this.hold() did that), so what is left is backend cleanup and
      // making sure it never un-holds.
      for (const hold of entry.holds) {
        await hold.onRefuse();
      }
      this.#forget(digest, entry, { unmask: false });
      return;
    }

    // Still 'hold' (or an out-of-scope 'flag', which this decorator never
    // produces through SafetyPolicy but must not crash a background retry
    // on): keep waiting. Nothing here ever decides to serve on a stale or
    // absent verdict.
    this.#scheduleRetry(digest);
  }

  async #quarantineCleanup(digest) {
    // Best-effort: promotion makes the object backup-eligible from its
    // real served location, so the quarantine copy is no longer the only
    // record of it and does not need to persist.
    try {
      await fs.rm(path.join(this.quarantinePath, digest), { force: true });
    } catch {
      // A leftover quarantine copy of a now-promoted, now-served object is
      // untidy, never unsafe.
    }
  }

  #forget(digest, entry, { unmask }) {
    this.entries.delete(digest);
    clearTimeout(entry.timer); // always set -- see #scheduleRetry
    if (unmask) {
      for (const hold of entry.holds) {
        this.urlKeys.delete(hold.urlKey); // always provided -- see #registerHold callers
        if (hold.pathKey) this.pathKeys.delete(hold.pathKey);
      }
    }
  }

  // Test/shutdown hygiene only: stops every pending retry without
  // resolving any of them. Never called from production code paths.
  stopAll() {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
  }
}

function normalizePathKey(key) {
  return key.replace(/^\/+/, '');
}

module.exports = { HoldRegistry, evaluate, DEFAULT_RETRY_INTERVAL_MS };

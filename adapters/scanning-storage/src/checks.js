'use strict';

// A Check declares `kind`, `blocking`, and a `run` that must never throw and
// must time out. The adapter runs only the checks whose `blocking` is true --
// an advisory check can never acquire the power to refuse a customer's
// upload by construction, because the adapter never asks it to.
const DEFAULT_TIMEOUT_MS = 2000;
// Decoding and hashing a large picture is real work, so it gets its own,
// longer budget than a verdict round trip.
const DEFAULT_HASH_TIMEOUT_MS = 10_000;

const NO_HASH_SOURCE = 'pdq-hash-unavailable';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ classification: 'unavailable', source: 'timeout' }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Two injected functions, because two different things name the bytes:
// `computeDigest(buffer)` is the content digest that files, quarantine and
// the hold registry are keyed by, and `computeVerdictKey(buffer)` resolves
// to `{hash, reason}` where `hash` is the perceptual hash the verdict
// client is asked about, or null when these bytes have none. A verdict key
// is never used as a file name: a verdict's `evidence` is always the
// content digest, whatever the client echoes back.
function createPdqKnownMaterialCheck(
  verdictClient,
  {
    computeDigest,
    computeVerdictKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    hashTimeoutMs = DEFAULT_HASH_TIMEOUT_MS,
  } = {}
) {
  if (typeof computeDigest !== 'function') {
    throw new Error('createPdqKnownMaterialCheck requires a computeDigest(buffer) function');
  }
  if (typeof computeVerdictKey !== 'function') {
    throw new Error('createPdqKnownMaterialCheck requires a computeVerdictKey(buffer) function');
  }

  async function keyFor(buffer) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ hash: null, reason: 'hash-timeout' }), hashTimeoutMs);
    });
    try {
      const keyed = await Promise.race([computeVerdictKey(buffer), deadline]);
      return keyed && typeof keyed.hash === 'string'
        ? keyed
        : { hash: null, reason: (keyed && keyed.reason) || 'no-hash' };
    } catch {
      return { hash: null, reason: 'hash-failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'media',
    blocking: true,
    // `run` must not throw: a verdict client failure or timeout resolves to
    // an 'unavailable' verdict rather than rejecting, so a single check's
    // outage cannot crash the save() call around it. Bytes with no hash are
    // 'unavailable' too, which the policy holds: they are never allowed on
    // the strength of a question nobody could ask.
    async run(subject) {
      const digest = computeDigest(subject.buffer);
      const keyed = await keyFor(subject.buffer);
      if (keyed.hash === null) {
        return {
          classification: 'unavailable',
          source: NO_HASH_SOURCE,
          reason: keyed.reason,
          evidence: digest,
        };
      }
      try {
        const verdict = await withTimeout(verdictClient.getVerdict(keyed.hash), timeoutMs);
        return { ...verdict, evidence: digest, verdictKey: keyed.hash };
      } catch {
        return {
          classification: 'unavailable',
          source: 'pdq-known-material-check',
          evidence: digest,
          verdictKey: keyed.hash,
        };
      }
    },
  };
}

module.exports = {
  createPdqKnownMaterialCheck,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HASH_TIMEOUT_MS,
  NO_HASH_SOURCE,
};

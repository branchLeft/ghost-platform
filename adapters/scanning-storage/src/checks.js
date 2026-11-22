'use strict';

// A Check declares `kind`, `blocking`, and a `run` that must never throw and
// must time out. The adapter runs only the checks whose `blocking` is true --
// an advisory check can never acquire the power to refuse a customer's
// upload by construction, because the adapter never asks it to.
const DEFAULT_TIMEOUT_MS = 2000;

// Resolved by the timer, so a timeout is told apart from a verdict by
// identity and not by anything a verdict source could say.
const TIMED_OUT = Symbol('verdict-timed-out');

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Bounded, single-line text for log output; a rejection need not be an Error
// and may not be printable (null prototype, throwing toString or message).
function describe(value, max) {
  try {
    return String(value?.message ?? value)
      .replace(/\s+/g, ' ')
      .slice(0, max);
  } catch {
    return '<unprintable>';
  }
}

function logUnavailable(logger, reason, digest, cause) {
  if (!logger || typeof logger.error !== 'function') return;
  const error = reason === 'error' ? ` error=${describe(cause, 200)}` : '';
  try {
    logger.error(
      `PdqKnownMaterialCheck: VERDICT_UNAVAILABLE reason=${reason} digest=${JSON.stringify(describe(digest, 128))}${error}`
    );
  } catch {
    // A logger that throws must not turn a hold into a crash.
  }
}

// The verdict key of these bytes, or null when they have none. A primitive that
// throws or resolves to anything but a usable hash is the same as no hash:
// the check must not throw, and bytes without a key are never allowed.
async function hashOrNone(computeVerdictKey, buffer, logger, digest) {
  try {
    const keyed = await computeVerdictKey(buffer);
    if (keyed && typeof keyed.hash === 'string' && keyed.hash.length > 0) return keyed.hash;
    logUnavailable(logger, `no-perceptual-hash(${describe(keyed && keyed.reason, 40)})`, digest);
  } catch (error) {
    logUnavailable(logger, 'error', digest, error);
  }
  return null;
}

// Two things name an upload here and they are never confused. `computeDigest`
// (SHA-256) names the exact bytes: the evidence of every verdict, and what the
// quarantine files are filed under. `computeVerdictKey` is what the hash source
// is asked about: a perceptual hash, the same for near-identical pictures. It
// resolves to `{hash, reason}` and never rejects; a null hash (bytes that are
// not a decodable image) is not asked about at all and is never allowed on that
// basis: the verdict is `unavailable`, which the policy holds.
// Both primitives are injected, so a different hash can replace either.
// `metrics`, when given, is told each outcome and how long it took.
// `logger`, when given, gets one error line per failed lookup.
function createPdqKnownMaterialCheck(
  verdictClient,
  {
    computeDigest,
    computeVerdictKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    metrics = null,
    now = Date.now,
    logger = null,
  } = {}
) {
  if (typeof computeDigest !== 'function') {
    throw new Error('createPdqKnownMaterialCheck requires a computeDigest(buffer) function');
  }
  if (typeof computeVerdictKey !== 'function') {
    throw new Error('createPdqKnownMaterialCheck requires a computeVerdictKey(buffer) function');
  }

  return {
    kind: 'media',
    blocking: true,
    // `run` must not throw: a verdict client failure or timeout resolves to
    // an 'unavailable' verdict rather than rejecting, so a single check's
    // outage cannot crash the save() call around it.
    async run(subject) {
      const digest = computeDigest(subject.buffer);
      const key = await hashOrNone(computeVerdictKey, subject.buffer, logger, digest);
      if (key === null) {
        // No question was put to the hash source, so no latency or error is
        // recorded: only the outcome.
        const none = {
          classification: 'unavailable',
          source: 'no-perceptual-hash',
          evidence: digest,
        };
        if (metrics) metrics.recordVerdict(none.classification);
        return none;
      }
      const started = now();
      let errorKind = null;
      let result;
      try {
        const answer = await withTimeout(verdictClient.getVerdict(key), timeoutMs);
        if (answer === TIMED_OUT) {
          errorKind = 'timeout';
          logUnavailable(logger, 'timeout', digest);
          result = { classification: 'unavailable', source: 'timeout', evidence: digest };
        } else {
          // The evidence is always the content digest, whatever the client echoes.
          result = { ...answer, evidence: digest };
        }
      } catch (error) {
        errorKind = 'error';
        logUnavailable(logger, 'error', digest, error);
        result = {
          classification: 'unavailable',
          source: 'pdq-known-material-check',
          evidence: digest,
        };
      }
      if (metrics) {
        metrics.observeVerdictSeconds((now() - started) / 1000);
        metrics.recordVerdict(result.classification);
        if (errorKind) metrics.recordVerdictError(errorKind);
      }
      return result;
    },
  };
}

module.exports = { createPdqKnownMaterialCheck, DEFAULT_TIMEOUT_MS };

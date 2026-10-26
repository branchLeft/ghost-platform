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

// The hash primitive is injected rather than fixed, so a different
// perceptual hash can replace it without touching this Check's shape.
// `metrics`, when given, is told each outcome and how long it took.
// `logger`, when given, gets one error line per failed lookup.
function createPdqKnownMaterialCheck(
  verdictClient,
  {
    computeDigest,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    metrics = null,
    now = Date.now,
    logger = null,
  } = {}
) {
  if (typeof computeDigest !== 'function') {
    throw new Error('createPdqKnownMaterialCheck requires a computeDigest(buffer) function');
  }

  return {
    kind: 'media',
    blocking: true,
    // `run` must not throw: a verdict client failure or timeout resolves to
    // an 'unavailable' verdict rather than rejecting, so a single check's
    // outage cannot crash the save() call around it.
    async run(subject) {
      const digest = computeDigest(subject.buffer);
      const started = now();
      let errorKind = null;
      let result;
      try {
        const answer = await withTimeout(verdictClient.getVerdict(digest), timeoutMs);
        if (answer === TIMED_OUT) {
          errorKind = 'timeout';
          logUnavailable(logger, 'timeout', digest);
          result = { classification: 'unavailable', source: 'timeout', evidence: digest };
        } else {
          result = { ...answer, evidence: answer.evidence ?? digest };
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

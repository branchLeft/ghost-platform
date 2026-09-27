'use strict';

// A Check declares `kind`, `blocking`, and a `run` that must never throw and
// must time out. The adapter runs only the checks whose `blocking` is true --
// an advisory check can never acquire the power to refuse a customer's
// upload by construction, because the adapter never asks it to.
const DEFAULT_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ classification: 'unavailable', source: 'timeout' }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The hash primitive is injected rather than fixed, so a different
// perceptual hash can replace it without touching this Check's shape.
function createPdqKnownMaterialCheck(
  verdictClient,
  { computeDigest, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
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
      try {
        const verdict = await withTimeout(verdictClient.getVerdict(digest), timeoutMs);
        return { ...verdict, evidence: verdict.evidence ?? digest };
      } catch {
        return {
          classification: 'unavailable',
          source: 'pdq-known-material-check',
          evidence: digest,
        };
      }
    },
  };
}

module.exports = { createPdqKnownMaterialCheck, DEFAULT_TIMEOUT_MS };

// The promotion predicate: what the promote-candidate workflow signs onto an
// image digest, and the one check every reader of it shares. No dependency
// beyond node built-ins, so the signing job can run it without an install.
// Meaning, fields and what is not claimed: ./README.md.
import { DIGEST_PATTERN, REQUIRED_GATES } from '../gate-set/gate-set.mjs';

export const PREDICATE_TYPE = 'https://github.com/branchLeft/ghost-platform/promotion/v1';
export const SCHEMA = 'promotion/v1';

export const ROUTE = Object.freeze({ FAST_PATH: 'fast-path', CONSENT: 'consent' });

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const refuse = (reason, detail) => ({ ok: false, reason, detail });

/**
 * Pure. Accepts a predicate only when it is for exactly the release asked
 * about and is well formed. A fast-path predicate must also carry its own
 * evidence: a reversible classification, a green gate record that holds every
 * required gate once, and no refusal. A consent predicate is accepted as a
 * well-formed record of a hold; whoever applies it refuses it.
 *
 * expected: { digest, version, fromVersion }.
 */
export function checkPredicate(predicate, expected) {
  if (!isObject(predicate) || predicate.schema !== SCHEMA) {
    return refuse('predicate-malformed', `the predicate schema is not ${SCHEMA}`);
  }
  if (!DIGEST_PATTERN.test(expected?.digest ?? '')) {
    return refuse('expected-malformed', 'the expected digest is not sha256:<64 hex>');
  }
  if (
    !RELEASE_TAG.test(expected?.version ?? '') ||
    !RELEASE_TAG.test(expected?.fromVersion ?? '')
  ) {
    return refuse('expected-malformed', 'the expected releases are not plain tags');
  }
  if (predicate.digest !== expected.digest) {
    return refuse('digest-mismatch', 'the predicate is for another digest');
  }
  if (predicate.version !== expected.version || predicate.fromVersion !== expected.fromVersion) {
    return refuse('release-mismatch', 'the predicate is for another release');
  }
  if (!SHA256_HEX.test(predicate.policySha256 ?? '')) {
    return refuse('policy-hash-missing', 'the predicate carries no sha256 policy hash');
  }
  if (predicate.route !== ROUTE.FAST_PATH && predicate.route !== ROUTE.CONSENT) {
    return refuse('route-unknown', 'the route is neither fast-path nor consent');
  }
  if (!isObject(predicate.classification) || !isObject(predicate.gates)) {
    return refuse('predicate-malformed', 'the classification or gate section is missing');
  }
  if (!Array.isArray(predicate.refusals) || !Array.isArray(predicate.gates.results)) {
    return refuse('predicate-malformed', 'the refusals or gate results are not lists');
  }
  if (predicate.route === ROUTE.CONSENT) return { ok: true };

  if (predicate.refusals.length > 0) {
    return refuse('route-contradicted', 'a fast-path predicate lists a refusal');
  }
  if (predicate.classification.ok !== true) {
    return refuse(
      'route-contradicted',
      'a fast-path predicate without a reversible classification'
    );
  }
  if (predicate.gates.ok !== true) {
    return refuse('route-contradicted', 'a fast-path predicate without a green gate record');
  }
  for (const name of REQUIRED_GATES) {
    const rows = predicate.gates.results.filter((r) => r?.name === name);
    if (rows.length !== 1 || rows[0].ok !== true) {
      return refuse('route-contradicted', `a fast-path predicate without a green ${name} gate`);
    }
  }
  if (predicate.gates.results.some((r) => r?.ok !== true)) {
    return refuse('route-contradicted', 'a fast-path predicate with a red gate result');
  }
  return { ok: true };
}

// The gate over a release-reversibility record. Pure: it reads the record and the
// release being applied, and answers ok or a named refusal. There is no approving
// route and no consent route: a record that is not plainly reversible is refused.
// Meaning of the record: ./steps.mjs and ../README.md (Release gate).

import { parseRelease } from './classify.mjs';
import { CLASS, SCHEMA } from './steps.mjs';

// A plain tag is exactly v?MAJOR.MINOR.PATCH. parseRelease alone trims, so a padded
// tag would pass it; the gate reads the string as written.
const PLAIN_TAG = /^v?\d+\.\d+\.\d+$/;

export const REFUSAL = Object.freeze({
  RECORD_UNREADABLE: 'record-unreadable',
  RELEASE_MISMATCH: 'release-mismatch',
  CHAIN_BROKEN: 'chain-broken',
  UNCLASSIFIED: 'unclassified',
  FORWARD_ONLY: 'forward-only',
});

const CLASSES = Object.values(CLASS);

class Unreadable extends Error {}

const refuse = (reason, detail) => ({ ok: false, reason, detail });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const compare = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

function plainTag(tag) {
  return typeof tag === 'string' && PLAIN_TAG.test(tag);
}

function need(cond, what) {
  if (!cond) throw new Unreadable(what);
}

// The step's own tags decide whether it moves forward and whether it is a major bump.
// The record's majorBump is checked against them: a record may not call a major bump
// minor, and it may call a minor bump major (that is refused as forward-only below).
function readStep(step, i) {
  need(isObject(step), `step ${i} is not an object`);
  need(plainTag(step.from) && plainTag(step.to), `step ${i} has no plain from and to tags`);
  const f = parseRelease(step.from);
  const t = parseRelease(step.to);
  need(compare(t, f) > 0, `step ${i} does not move forward from ${step.from} to ${step.to}`);
  need(CLASSES.includes(step.class), `step ${i} has an unknown class`);
  need(typeof step.majorBump === 'boolean', `step ${i} has no majorBump flag`);
  need(!(t.major > f.major) || step.majorBump, `step ${i} is a major bump its record calls minor`);
  need(Array.isArray(step.forwardOnly), `step ${i} has no forwardOnly list`);
  need(Array.isArray(step.unclassified), `step ${i} has no unclassified list`);
  need(step.forwardOnly.every(isObject), `step ${i} has a malformed forwardOnly hit`);
  need(step.unclassified.every(isObject), `step ${i} has a malformed unclassified hit`);
  return { ...step, majorBump: t.major > f.major || step.majorBump };
}

const hit = (h) => `${h.path || '(release)'} ${h.rule}`;

// record: a release-reversibility/v1 record. release: { pinned, target } plain tags of
// the upgrade about to be applied. The record's own `class` is never trusted alone:
// each step's lists are read, and the record is accepted only when both agree.
// Never throws: any failure to read the record or the release, including a getter
// that throws or a value that cannot be printed, is a refusal.
export function assertReleaseReversible(record, release) {
  try {
    return decide(record, release);
  } catch (err) {
    if (err instanceof Unreadable) return refuse(REFUSAL.RECORD_UNREADABLE, err.message);
    return refuse(REFUSAL.RECORD_UNREADABLE, 'the record could not be read');
  }
}

function decide(record, release) {
  need(isObject(record), 'the record is not an object');
  need(record.schema === SCHEMA, `the record schema is not ${SCHEMA}`);
  need(plainTag(record.pinned), 'the record has no plain pinned tag');
  need(CLASSES.includes(record.class), 'the record has an unknown class');
  need(
    Number.isInteger(record.unclassifiedFiles) && record.unclassifiedFiles >= 0,
    'the record has no unclassified file count'
  );
  need(Array.isArray(record.steps), 'the record has no steps list');
  const steps = record.steps.map(readStep);

  if (!isObject(release) || !plainTag(release.pinned) || !plainTag(release.target)) {
    return refuse(REFUSAL.RELEASE_MISMATCH, 'the release to apply has no plain pinned and target');
  }
  if (record.pinned !== release.pinned) {
    return refuse(REFUSAL.RELEASE_MISMATCH, 'the record is for another pinned release');
  }
  if (steps.length === 0) return refuse(REFUSAL.CHAIN_BROKEN, 'the record holds no step');
  let at = release.pinned;
  for (const [i, step] of steps.entries()) {
    if (step.from !== at) {
      return refuse(REFUSAL.CHAIN_BROKEN, `step ${i} starts at ${step.from}, not ${at}`);
    }
    at = step.to;
  }
  if (at !== release.target) {
    return refuse(REFUSAL.RELEASE_MISMATCH, `the record ends at ${at}, not the target`);
  }

  const forwardOnly = steps.flatMap((s) => [
    ...(s.majorBump ? ['(release) major-bump'] : []),
    ...s.forwardOnly.map(hit),
  ]);
  const claimed =
    record.class === CLASS.FORWARD_ONLY || steps.some((s) => s.class === CLASS.FORWARD_ONLY);
  if (forwardOnly.length > 0 || claimed) {
    return refuse(REFUSAL.FORWARD_ONLY, `forward-only: ${forwardOnly.join('; ') || 'by class'}`);
  }
  const unread = steps.flatMap((s) => s.unclassified.map(hit));
  const unreadClass =
    record.class === CLASS.UNCLASSIFIED || steps.some((s) => s.class === CLASS.UNCLASSIFIED);
  if (unread.length > 0 || unreadClass || record.unclassifiedFiles > 0) {
    return refuse(REFUSAL.UNCLASSIFIED, `unclassified: ${unread.join('; ') || 'by class'}`);
  }
  if (record.class !== CLASS.REVERSIBLE || steps.some((s) => s.class !== CLASS.REVERSIBLE)) {
    return refuse(REFUSAL.UNCLASSIFIED, 'the record does not say reversible');
  }
  return { ok: true };
}

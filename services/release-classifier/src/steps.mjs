// Per-release-step reversibility, as data a gate can read. A step is one release to
// the next; only migrations new in the target release are classified. Rules and the
// meaning of each class: ../README.md (Release steps).

import { classifySource, parseRelease } from './classify.mjs';

export const SCHEMA = 'release-reversibility/v1';

// reversible: the previous image still runs on the migrated database.
// forward-only: it may not; the way back is a restore of the pre-upgrade backup.
// unclassified: no forward-only evidence, but a new migration could not be read or a
// known one vanished, so reversible is not established.
export const CLASS = Object.freeze({
  REVERSIBLE: 'reversible',
  FORWARD_ONLY: 'forward-only',
  UNCLASSIFIED: 'unclassified',
});

// Classes of classifySource whose hits make a step forward-only.
const FORWARD_ONLY_CLASSES = Object.freeze([
  'irreversible',
  'destructive',
  'contracting',
  'constraint',
  'schemaChange',
]);

const compare = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Migrations of `next` that `previous` does not hold at the same path with the same
// source. An edited migration counts as new: reading it again can only refuse more.
export function newMigrations(previous, next) {
  const before = new Map(previous.map((m) => [m.path, m.source]));
  return next.filter((m) => before.get(m.path) !== m.source);
}

function removedMigrations(previous, next) {
  const after = new Set(next.map((m) => m.path));
  return previous.filter((m) => !after.has(m.path));
}

// Input: from, to (plain release tags, to after from), previous and next ({ folder,
// path, source }[] of the two releases' migration trees).
export function classifyStep({ from, to, previous, next }) {
  const f = parseRelease(from);
  const t = parseRelease(to);
  if (compare(t, f) <= 0) throw new Error(`target ${to} does not follow ${from}`);
  const majorBump = t.major > f.major;
  const fresh = newMigrations(previous, next);
  const forwardOnly = [];
  const unclassified = [];
  if (majorBump) forwardOnly.push({ path: '', class: 'major', rule: 'major-bump' });
  for (const m of fresh) {
    const file = classifySource(m.source);
    for (const cls of FORWARD_ONLY_CLASSES) {
      for (const rule of file[cls]) forwardOnly.push({ path: m.path, class: cls, rule });
    }
    for (const rule of file.unclassified) {
      unclassified.push({ path: m.path, rule: `unclassified:${rule}` });
    }
  }
  for (const m of removedMigrations(previous, next)) {
    unclassified.push({ path: m.path, rule: 'removed-migration' });
  }
  forwardOnly.sort(byPath);
  unclassified.sort(byPath);
  // Forward-only wins over unclassified: no unread file can make a step less reversible
  // than forward-only, and the unclassified list stays in the record for a gate that
  // refuses on it.
  let cls = CLASS.REVERSIBLE;
  if (unclassified.length > 0) cls = CLASS.UNCLASSIFIED;
  if (forwardOnly.length > 0) cls = CLASS.FORWARD_ONLY;
  return { from, to, class: cls, majorBump, newFiles: fresh.length, forwardOnly, unclassified };
}

const SEVERITY = [CLASS.REVERSIBLE, CLASS.UNCLASSIFIED, CLASS.FORWARD_ONLY];

// Input: releases, ordered oldest first; the first is the pinned release and its
// migrations are the baseline. Each later release is one step from the one before.
export function classifySteps({ releases }) {
  if (!Array.isArray(releases) || releases.length < 2) {
    throw new Error('need at least two releases: the pinned one and one to move to');
  }
  const steps = [];
  for (let i = 1; i < releases.length; i += 1) {
    steps.push(
      classifyStep({
        from: releases[i - 1].tag,
        to: releases[i].tag,
        previous: releases[i - 1].migrations,
        next: releases[i].migrations,
      })
    );
  }
  const worst = Math.max(...steps.map((s) => SEVERITY.indexOf(s.class)));
  const unclassifiedFiles = steps.reduce((n, s) => n + s.unclassified.length, 0);
  return {
    schema: SCHEMA,
    pinned: releases[0].tag,
    class: SEVERITY[worst],
    unclassifiedFiles,
    steps,
  };
}

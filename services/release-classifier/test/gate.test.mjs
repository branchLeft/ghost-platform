import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readMigrations } from '../src/cli.mjs';
import { REFUSAL, assertReleaseReversible } from '../src/gate.mjs';
import { classifySteps } from '../src/steps.mjs';
import { main } from '../src/gate-cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir) => readMigrations(join(here, 'fixtures', dir));
const fast = load('fast-path');
const versions = load('versions');
const extra = load('steps');
const inFolder = (list, folder) => list.filter((m) => m.folder === folder);

// Real trees, as in the step tests: a patch with no new migration, one real
// reversible step (signing-key settings), and real forward-only steps.
const t656 = [...inFolder(extra, '6.56'), ...inFolder(fast, '6.56')];
const t657 = [...t656, ...inFolder(versions, '6.57')];
const t665 = inFolder(fast, '6.65');
const t666 = [...t665, ...inFolder(fast, '6.66')];

const record = (releases) => classifySteps({ releases });
const reversible = record([
  { tag: 'v6.65.0', migrations: t665 },
  { tag: 'v6.66.0', migrations: t666 },
]);
const patch = record([
  { tag: 'v6.57.0', migrations: t657 },
  { tag: 'v6.57.1', migrations: t657 },
]);
const forwardOnly = record([
  { tag: 'v6.56.0', migrations: t656 },
  { tag: 'v6.57.0', migrations: t657 },
]);
const clone = (x) => JSON.parse(JSON.stringify(x));

const upgrade = { pinned: 'v6.65.0', target: 'v6.66.0' };

test('the real reversible step passes, and so does a patch that adds no migration', () => {
  assert.deepEqual(assertReleaseReversible(reversible, upgrade), { ok: true });
  assert.deepEqual(assertReleaseReversible(patch, { pinned: 'v6.57.0', target: 'v6.57.1' }), {
    ok: true,
  });
});

test('a real forward-only step is refused, and the refusal names the hits', () => {
  const verdict = assertReleaseReversible(forwardOnly, { pinned: 'v6.56.0', target: 'v6.57.0' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.FORWARD_ONLY);
  assert.match(verdict.detail, /drop-column/);
});

test('a record that is not the release being applied is refused', () => {
  for (const wrong of [
    { pinned: 'v6.65.1', target: 'v6.66.0' },
    { pinned: 'v6.65.0', target: 'v6.67.0' },
    { pinned: 'v6.66.0', target: 'v6.65.0' },
    { pinned: '', target: 'v6.66.0' },
    { pinned: 'v6.65.0' },
    {},
    undefined,
  ]) {
    const verdict = assertReleaseReversible(reversible, wrong);
    assert.equal(verdict.ok, false, JSON.stringify(wrong));
    assert.equal(verdict.reason, REFUSAL.RELEASE_MISMATCH, JSON.stringify(wrong));
  }
});

test('an unclassified step is refused, by class and by its listed files', () => {
  const byClass = clone(reversible);
  byClass.class = 'unclassified';
  byClass.steps[0].class = 'unclassified';
  byClass.steps[0].unclassified = [{ path: '6.66/x.js', rule: 'unclassified:syntax' }];
  byClass.unclassifiedFiles = 1;
  const a = assertReleaseReversible(byClass, upgrade);
  assert.equal(a.ok, false);
  assert.equal(a.reason, REFUSAL.UNCLASSIFIED);
  assert.match(a.detail, /6\.66\/x\.js/);

  // A record that claims reversible while its own step lists an unread file.
  const lying = clone(reversible);
  lying.steps[0].unclassified = [{ path: '6.66/x.js', rule: 'removed-migration' }];
  const b = assertReleaseReversible(lying, upgrade);
  assert.equal(b.ok, false);
  assert.equal(b.reason, REFUSAL.UNCLASSIFIED);

  const counted = clone(reversible);
  counted.unclassifiedFiles = 2;
  assert.equal(assertReleaseReversible(counted, upgrade).reason, REFUSAL.UNCLASSIFIED);
});

test('a record that claims reversible while a step carries a forward-only hit is refused', () => {
  const lying = clone(reversible);
  lying.steps[0].forwardOnly = [{ path: '6.66/x.js', class: 'contracting', rule: 'drop-column' }];
  const verdict = assertReleaseReversible(lying, upgrade);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.FORWARD_ONLY);

  const major = clone(reversible);
  major.steps[0].majorBump = true;
  assert.equal(assertReleaseReversible(major, upgrade).reason, REFUSAL.FORWARD_ONLY);

  const topOnly = clone(reversible);
  topOnly.class = 'forward-only';
  assert.equal(assertReleaseReversible(topOnly, upgrade).reason, REFUSAL.FORWARD_ONLY);
});

test('a forward-only step is refused even when the record also lists unread files', () => {
  const both = clone(forwardOnly);
  both.steps[0].unclassified = [{ path: '6.57/y.js', rule: 'unclassified:syntax' }];
  both.unclassifiedFiles = 1;
  const verdict = assertReleaseReversible(both, { pinned: 'v6.56.0', target: 'v6.57.0' });
  assert.equal(verdict.ok, false);
  // Forward-only wins over unclassified in the gate, as it does in the step classifier.
  assert.equal(verdict.reason, REFUSAL.FORWARD_ONLY);
});

test('a later step that is forward-only refuses the whole range', () => {
  const longer = clone(reversible);
  longer.steps.push({
    from: 'v6.66.0',
    to: 'v6.67.0',
    class: 'forward-only',
    majorBump: false,
    newFiles: 1,
    forwardOnly: [{ path: '6.67/z.js', class: 'destructive', rule: 'delete-table' }],
    unclassified: [],
  });
  const verdict = assertReleaseReversible(longer, { pinned: 'v6.65.0', target: 'v6.67.0' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.FORWARD_ONLY);
  assert.match(verdict.detail, /delete-table/);
});

test('a chain that does not run from the pinned release to the target is refused', () => {
  const gap = clone(reversible);
  gap.steps.push({ ...clone(gap.steps[0]), from: 'v6.67.0', to: 'v6.68.0' });
  const verdict = assertReleaseReversible(gap, { pinned: 'v6.65.0', target: 'v6.68.0' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.CHAIN_BROKEN);

  const startsLate = clone(reversible);
  startsLate.pinned = 'v6.64.0';
  assert.equal(
    assertReleaseReversible(startsLate, { pinned: 'v6.64.0', target: 'v6.66.0' }).reason,
    REFUSAL.CHAIN_BROKEN
  );

  const empty = clone(reversible);
  empty.steps = [];
  assert.equal(assertReleaseReversible(empty, upgrade).reason, REFUSAL.CHAIN_BROKEN);
});

test('an unreadable record is refused, never thrown', () => {
  const cases = [
    undefined,
    null,
    '',
    'reversible',
    42,
    [],
    {},
    { schema: 'release-reversibility/v1' },
    { ...clone(reversible), schema: 'release-reversibility/v0' },
    { ...clone(reversible), steps: 'none' },
    { ...clone(reversible), steps: [null] },
    { ...clone(reversible), steps: [{}] },
    { ...clone(reversible), class: 'maybe' },
    { ...clone(reversible), unclassifiedFiles: 'zero' },
    { ...clone(reversible), unclassifiedFiles: -1 },
  ];
  for (const bad of cases) {
    const verdict = assertReleaseReversible(bad, upgrade);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
    assert.ok(
      [REFUSAL.RECORD_UNREADABLE, REFUSAL.CHAIN_BROKEN].includes(verdict.reason),
      `${JSON.stringify(bad)} -> ${verdict.reason}`
    );
  }
  const stepBad = clone(reversible);
  stepBad.steps[0].forwardOnly = 'none';
  assert.equal(assertReleaseReversible(stepBad, upgrade).reason, REFUSAL.RECORD_UNREADABLE);
  const stepClass = clone(reversible);
  stepClass.steps[0].class = 'fine';
  assert.equal(assertReleaseReversible(stepClass, upgrade).reason, REFUSAL.RECORD_UNREADABLE);
});

test('the verdict has no approving route: only ok true or a named refusal', () => {
  const verdicts = [
    assertReleaseReversible(reversible, upgrade),
    assertReleaseReversible(forwardOnly, upgrade),
    assertReleaseReversible(null, upgrade),
  ];
  for (const v of verdicts) {
    if (v.ok) assert.deepEqual(Object.keys(v), ['ok']);
    else {
      assert.deepEqual(Object.keys(v).sort(), ['detail', 'ok', 'reason']);
      assert.ok(Object.values(REFUSAL).includes(v.reason));
    }
  }
});

function writeJson(value) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'record.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function run(argv) {
  const out = [];
  const err = [];
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (s) => (out.push(String(s)), true);
  process.stderr.write = (s) => (err.push(String(s)), true);
  try {
    return { code: main(argv), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

test('cli: exit 0 only for an accepted record; 2 for a refusal; 1 for an error, never 0', () => {
  const args = (file) => ['--record', file, '--pinned', 'v6.65.0', '--target', 'v6.66.0'];
  const ok = run(args(writeJson(reversible)));
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.out).ok, true);

  const refused = run(args(writeJson(forwardOnly)));
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.out).ok, false);

  assert.equal(run(args(writeJson('{not json'))).code, 2, 'an unreadable record is a refusal');
  assert.equal(
    run(['--record', '/nonexistent/record.json', '--pinned', 'v6.65.0', '--target', 'v6.66.0'])
      .code,
    2
  );
  assert.equal(run(['--record', writeJson(reversible), '--pinned', 'v6.65.0']).code, 1);
  assert.equal(run([]).code, 1);
});

// a one-step record whose step is the given tags, with the given overrides.
const oneStep = (pinned, from, to, over = {}) => ({
  schema: 'release-reversibility/v1',
  pinned,
  class: 'reversible',
  unclassifiedFiles: 0,
  steps: [
    {
      from,
      to,
      class: 'reversible',
      majorBump: false,
      newFiles: 0,
      forwardOnly: [],
      unclassified: [],
      ...over,
    },
  ],
});

test('a record whose majorBump does not follow its tags is refused', () => {
  const verdict = assertReleaseReversible(oneStep('v6.66.0', 'v6.66.0', 'v7.0.0'), {
    pinned: 'v6.66.0',
    target: 'v7.0.0',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.RECORD_UNREADABLE);
});

test('a downgrade step and a step with from equal to to are refused', () => {
  const down = assertReleaseReversible(oneStep('v6.66.0', 'v6.66.0', 'v6.65.0'), {
    pinned: 'v6.66.0',
    target: 'v6.65.0',
  });
  assert.equal(down.ok, false);
  assert.equal(down.reason, REFUSAL.RECORD_UNREADABLE);

  const same = assertReleaseReversible(oneStep('v6.66.0', 'v6.66.0', 'v6.66.0'), {
    pinned: 'v6.66.0',
    target: 'v6.66.0',
  });
  assert.equal(same.ok, false);
  assert.equal(same.reason, REFUSAL.RECORD_UNREADABLE);
});

test('tags padded with spaces are refused, in the record and in the release', () => {
  const padded = assertReleaseReversible(oneStep(' v6.66.0', ' v6.66.0', 'v6.67.0 '), {
    pinned: ' v6.66.0',
    target: 'v6.67.0 ',
  });
  assert.equal(padded.ok, false);
  assert.equal(padded.reason, REFUSAL.RECORD_UNREADABLE);

  const paddedRelease = assertReleaseReversible(oneStep('v6.66.0', 'v6.66.0', 'v6.67.0'), {
    pinned: 'v6.66.0',
    target: ' v6.67.0',
  });
  assert.equal(paddedRelease.ok, false);
  assert.equal(paddedRelease.reason, REFUSAL.RELEASE_MISMATCH);
});

test('a throwing getter on the record is a refusal, never a throw', () => {
  const bad = oneStep('v6.66.0', 'v6.66.0', 'v6.67.0');
  Object.defineProperty(bad, 'class', {
    get() {
      throw new Error('getter');
    },
    enumerable: true,
  });
  let verdict;
  assert.doesNotThrow(() => {
    verdict = assertReleaseReversible(bad, { pinned: 'v6.66.0', target: 'v6.67.0' });
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.RECORD_UNREADABLE);
});

test('a Symbol in a hit is a refusal, never a throw', () => {
  const bad = oneStep('v6.66.0', 'v6.66.0', 'v6.67.0', {
    forwardOnly: [{ path: 'x.js', class: 'contracting', rule: Symbol('r') }],
  });
  let verdict;
  assert.doesNotThrow(() => {
    verdict = assertReleaseReversible(bad, { pinned: 'v6.66.0', target: 'v6.67.0' });
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REFUSAL.RECORD_UNREADABLE);
});

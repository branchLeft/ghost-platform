import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyRange, classifySource } from '../src/classify.mjs';
import { readMigrations } from '../src/cli.mjs';
import { CLASS, SCHEMA, classifyStep, classifySteps, newMigrations } from '../src/steps.mjs';
import { main } from '../src/steps-cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir) => readMigrations(join(here, 'fixtures', dir));
const versions = load('versions');
const fast = load('fast-path');
const extra = load('steps');
const renameAt658 = load('rename-at-v6.58.0');
const inFolder = (list, folder) => list.filter((m) => m.folder === folder);
const RENAME = '6.58/2026-08-11-21-22-48-rename-email-batches-provider-id.js';
const notRename = (list) => list.filter((m) => m.path !== RENAME);

// Real release trees, restricted to the folders each comparison reads. Every file is a
// copy of upstream Ghost source. The listings of 6.56, 6.57, 6.58, 6.59, 6.65 and 6.66
// were read from the upstream tags: a folder is complete where used here.
const t656 = [...inFolder(extra, '6.56'), ...inFolder(fast, '6.56')];
const t657 = [...t656, ...inFolder(versions, '6.57')];
const folder658 = [
  ...inFolder(versions, '6.58'),
  ...notRename(inFolder(fast, '6.58')),
  ...inFolder(extra, '6.58'),
];
const t658 = [...t657, ...folder658, ...renameAt658];
const renameEdited = inFolder(fast, '6.58').filter((m) => m.path === RENAME);
const t659 = [...t657, ...folder658, ...renameEdited, ...inFolder(fast, '6.59')];
const t665 = inFolder(fast, '6.65');
const t666 = [...t665, ...inFolder(fast, '6.66')];

const rules = (list) => list.map((x) => `${x.path} ${x.rule}`);

test('a file counts as new when its path is absent or its source changed', () => {
  assert.deepEqual(newMigrations(t657, t657), []);
  const grown = newMigrations(t657, t658).map((m) => m.path);
  assert.equal(grown.length, 8);
  assert.ok(grown.every((p) => p.startsWith('6.58/')));
  const edited = newMigrations(t658, t659).map((m) => m.path);
  assert.ok(edited.includes(RENAME), 'an edited migration is new');
  assert.equal(edited.length, 3);
});

test('real patch step v6.57.0 to v6.57.1 adds no migration and is reversible', () => {
  const step = classifyStep({ from: 'v6.57.0', to: 'v6.57.1', previous: t657, next: t657 });
  assert.equal(step.class, CLASS.REVERSIBLE);
  assert.equal(step.newFiles, 0);
  assert.deepEqual(step.forwardOnly, []);
  assert.deepEqual(step.unclassified, []);
  // The whole-range classifier, inclusive of the pinned folder, refuses the same patch.
  const range = classifyRange({ from: 'v6.57.0', to: 'v6.57.1', migrations: t657 });
  assert.equal(range.route, 'consent');
});

test('real step v6.65.0 to v6.66.0 adds one allowlisted settings migration and is reversible', () => {
  const step = classifyStep({ from: 'v6.65.0', to: 'v6.66.0', previous: t665, next: t666 });
  assert.equal(step.class, CLASS.REVERSIBLE, JSON.stringify(step));
  assert.equal(step.newFiles, 1);
});

test('real step v6.56.0 to v6.57.0 is forward-only: it drops columns and constraints', () => {
  const step = classifyStep({ from: 'v6.56.0', to: 'v6.57.0', previous: t656, next: t657 });
  assert.equal(step.newFiles, 2);
  assert.equal(step.class, CLASS.FORWARD_ONLY, JSON.stringify(step));
  const found = rules(step.forwardOnly);
  assert.ok(
    found.some((s) => s.endsWith(' drop-column')),
    found.join('\n')
  );
  assert.ok(step.unclassified.length > 0, 'the unread files stay in the record');
});

test('real step v6.57.1 to v6.58.0 renames email_batches.provider_id and is not reversible', () => {
  const step = classifyStep({ from: 'v6.57.1', to: 'v6.58.0', previous: t657, next: t658 });
  assert.equal(step.newFiles, 8);
  assert.equal(step.class, CLASS.FORWARD_ONLY);
  assert.ok(rules(step.forwardOnly).includes(`${RENAME} rename-column`));
  assert.ok(rules(step.forwardOnly).some((s) => s.endsWith(' delete-table')));
});

test('real step v6.58.0 to v6.59.0 reads the edited rename migration as new', () => {
  const step = classifyStep({ from: 'v6.58.0', to: 'v6.59.0', previous: t658, next: t659 });
  assert.equal(step.newFiles, 3);
  assert.ok(rules(step.forwardOnly).includes(`${RENAME} rename-column`));
  assert.notEqual(step.class, CLASS.REVERSIBLE);
});

test('the pinned route of the whole-range classifier is unchanged by the new class', () => {
  const r = classifyRange({ from: 'v6.58.0', to: 'v6.58.0', migrations: [renameAt658[0]] });
  assert.equal(r.route, 'fast-path');
  assert.deepEqual(
    r.schemaChange.map((x) => x.rule),
    ['rename-column']
  );
});

test('classifySource reads rename and nullability helpers as schema changes', () => {
  const using = (name) => `const { ${name} } = require('../../utils');\n`;
  const rename = classifySource(
    `${using('createRenameColumnMigration')}module.exports = createRenameColumnMigration('t', 'a', 'b');`
  );
  assert.deepEqual(rename.schemaChange, ['rename-column']);
  const nullable = classifySource(
    `${using('createSetNullableMigration')}module.exports = createSetNullableMigration('t', 'a', false);`
  );
  assert.deepEqual(nullable.schemaChange, ['set-nullable']);
  const additive = classifySource(
    "const { addSetting } = require('../../utils');\nmodule.exports = addSetting({ key: 'x', value: null, type: 'string', group: 'core' });"
  );
  assert.deepEqual(additive.schemaChange, []);
});

test('a major bump is forward-only even with no new migration', () => {
  const step = classifyStep({ from: 'v6.69.0', to: 'v7.0.0', previous: t665, next: t665 });
  assert.equal(step.class, CLASS.FORWARD_ONLY);
  assert.equal(step.majorBump, true);
  assert.deepEqual(rules(step.forwardOnly), [' major-bump']);
});

test('a migration present before and gone after is unclassified, never reversible', () => {
  const step = classifyStep({ from: 'v6.65.0', to: 'v6.65.1', previous: t666, next: t665 });
  assert.equal(step.class, CLASS.UNCLASSIFIED);
  assert.deepEqual(rules(step.unclassified), [
    '6.66/2026-09-28-18-58-53-add-signing-key-rotation-settings.js removed-migration',
  ]);
});

test('an unreadable new migration makes the step unclassified', () => {
  const broken = { folder: '6.66', path: '6.66/x.js', source: 'module.exports = (' };
  const step = classifyStep({
    from: 'v6.65.0',
    to: 'v6.66.0',
    previous: t665,
    next: [...t665, broken],
  });
  assert.equal(step.class, CLASS.UNCLASSIFIED);
  assert.deepEqual(rules(step.unclassified), ['6.66/x.js unclassified:syntax']);
});

test('an unreadable migration beside forward-only evidence stays in the record', () => {
  const broken = { folder: '6.58', path: '6.58/x.js', source: 'module.exports = (' };
  const step = classifyStep({
    from: 'v6.57.1',
    to: 'v6.58.0',
    previous: t657,
    next: [...t658, broken],
  });
  assert.equal(step.class, CLASS.FORWARD_ONLY);
  assert.ok(rules(step.unclassified).includes('6.58/x.js unclassified:syntax'));
  const out = classifySteps({
    releases: [
      { tag: 'v6.57.1', migrations: t657 },
      { tag: 'v6.58.0', migrations: [...t658, broken] },
    ],
  });
  assert.ok(out.unclassifiedFiles >= 1);
});

test('a step whose target does not follow its source is an error', () => {
  for (const [from, to] of [
    ['v6.66.0', 'v6.65.0'],
    ['v6.66.0', 'v6.66.0'],
    ['v6.66.0', '6.66'],
  ]) {
    assert.throws(
      () => classifyStep({ from, to, previous: t665, next: t666 }),
      Error,
      `${from} ${to}`
    );
  }
});

test('classifySteps walks consecutive releases and reports the worst class', () => {
  const out = classifySteps({
    releases: [
      { tag: 'v6.56.0', migrations: t656 },
      { tag: 'v6.57.0', migrations: t657 },
      { tag: 'v6.57.1', migrations: t657 },
      { tag: 'v6.58.0', migrations: t658 },
    ],
  });
  assert.equal(out.schema, SCHEMA);
  assert.equal(out.pinned, 'v6.56.0');
  assert.deepEqual(
    out.steps.map((s) => [s.from, s.to, s.class === CLASS.REVERSIBLE]),
    [
      ['v6.56.0', 'v6.57.0', false],
      ['v6.57.0', 'v6.57.1', true],
      ['v6.57.1', 'v6.58.0', false],
    ]
  );
  assert.notEqual(out.class, CLASS.REVERSIBLE);
  const clean = classifySteps({
    releases: [
      { tag: 'v6.65.0', migrations: t665 },
      { tag: 'v6.66.0', migrations: t666 },
    ],
  });
  assert.equal(clean.class, CLASS.REVERSIBLE);
});

test('classifySteps needs a pinned release and at least one step', () => {
  assert.throws(() => classifySteps({ releases: [] }), /at least two/);
  assert.throws(
    () => classifySteps({ releases: [{ tag: 'v6.65.0', migrations: t665 }] }),
    /at least two/
  );
});

function write(root, tag, migrations) {
  for (const m of migrations) {
    mkdirSync(join(root, tag, m.folder), { recursive: true });
    writeFileSync(join(root, tag, m.path), m.source);
  }
  return join(root, tag);
}

function run(argv) {
  let out = '';
  let err = '';
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (s) => ((out += s), true);
  process.stderr.write = (s) => ((err += s), true);
  try {
    return { code: main(argv), out, err };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

test('cli exits 0 when every step is reversible, 2 when any is not, 1 on an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-steps-'));
  const d665 = write(root, 'v6.65.0', t665);
  const d666 = write(root, 'v6.66.0', t666);
  const d657 = write(root, 'v6.57.0', t657);
  const d658 = write(root, 'v6.58.0', t658);

  const ok = run(['--release', `v6.65.0=${d665}`, '--release', `v6.66.0=${d666}`]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).class, CLASS.REVERSIBLE);

  const bad = run(['--release', `v6.57.0=${d657}`, '--release', `v6.58.0=${d658}`]);
  assert.equal(bad.code, 2, bad.err);
  const verdict = JSON.parse(bad.out);
  assert.equal(verdict.schema, SCHEMA);
  assert.notEqual(verdict.class, CLASS.REVERSIBLE);
  assert.ok(rules(verdict.steps[0].forwardOnly).includes(`${RENAME} rename-column`));

  for (const argv of [
    [],
    ['--release', `v6.65.0=${d665}`],
    ['--release', `v6.65.0=${d665}`, '--release', `v6.66.0=${join(root, 'missing')}`],
    ['--release', `v6.66.0=${d666}`, '--release', `v6.65.0=${d665}`],
    ['--release', 'v6.65.0', '--release', `v6.66.0=${d666}`],
    ['--versions', d665],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', 'nothing is classified on an error');
    assert.match(r.err, /release-classifier steps:/);
  }
});

test('a new NOT NULL column with no default makes the step forward-only', () => {
  const addRequired = {
    folder: '6.66',
    path: '6.66/add-required.js',
    source:
      "const { createAddColumnMigration } = require('../../utils');\n" +
      "module.exports = createAddColumnMigration('posts', 'x', { type: 'string', nullable: false });\n",
  };
  const step = classifyStep({
    from: 'v6.65.0',
    to: 'v6.66.0',
    previous: t665,
    next: [...t665, addRequired],
  });
  assert.equal(step.class, CLASS.FORWARD_ONLY, JSON.stringify(step));
  assert.deepEqual(rules(step.forwardOnly), ['6.66/add-required.js add-required-column']);
});

test('a step whose two trees hold no migration is an error, never reversible', () => {
  assert.throws(
    () => classifyStep({ from: 'v6.65.0', to: 'v6.66.0', previous: [], next: [] }),
    /no migration/
  );
});

test('the steps CLI refuses one directory passed for two tags, and reads two copies of a patch', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc-same-'));
  const same = write(root, 'v6.65.0', t665);
  const bothTags = run(['--release', `v6.65.0=${same}`, '--release', `v6.66.0=${same}`]);
  assert.equal(bothTags.code, 1, bothTags.out);
  assert.equal(bothTags.out, '');
  assert.match(bothTags.err, /same directory/);

  const copyA = write(root, 'v6.57.0', t657);
  const copyB = write(root, 'v6.57.1', t657);
  const patch = run(['--release', `v6.57.0=${copyA}`, '--release', `v6.57.1=${copyB}`]);
  assert.equal(patch.code, 0, patch.err);
});

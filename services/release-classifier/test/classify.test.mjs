import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyRange, CONTRACTING_ROUTE, parseRelease } from '../src/classify.mjs';
import { readMigrations, main } from '../src/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = readMigrations(join(here, 'fixtures', 'versions'));

const synthetic = (folder, path, source) => ({ folder, path, source });

test('parseRelease accepts plain tags and rejects prereleases', () => {
  assert.deepEqual(parseRelease('v6.55.0'), { major: 6, minor: 55, patch: 0 });
  assert.throws(() => parseRelease('v6.0.0-rc.2'), /not a plain release tag/);
});

test('the pinned range 6.55.0 to 6.69.0 reads only folders 6.55 to 6.69', () => {
  const r = classifyRange({ from: 'v6.55.0', to: 'v6.69.0', migrations: fixtures });
  assert.equal(r.filesInRange, 3, 'the 6.0 fixture must be outside this range');
  assert.deepEqual(r.irreversible, []);
  assert.equal(r.majorBump, false);
});

test('the 6.57 data-deleting migrations are contracting, and the range routes to consent', () => {
  const r = classifyRange({ from: 'v6.55.0', to: 'v6.69.0', migrations: fixtures });
  const hits = r.contracting.map((c) => `${c.path} ${c.rule}`).sort();
  assert.deepEqual(hits, [
    '6.57/2026-08-04-18-00-00-store-custom-field-values-as-leaf-rows.js data-delete',
    '6.57/2026-08-04-18-00-00-store-custom-field-values-as-leaf-rows.js drop-column',
    '6.57/2026-08-04-18-54-14-reset-automation-email-analytics.js data-delete',
  ]);
  assert.equal(r.route, 'consent');
});

test('CONTRACTING_ROUTE is pinned to consent until Rob rules', () => {
  assert.equal(CONTRACTING_ROUTE, 'consent');
});

test('wrapper rule: the 6.0 dropTables migration is irreversible', () => {
  const r = classifyRange({ from: 'v6.0.0', to: 'v6.0.0', migrations: fixtures });
  assert.deepEqual(r.irreversible, [
    { path: '6.0/2025-06-30-13-59-10-remove-mail-events-table.js', rule: 'wrapper' },
  ]);
  assert.equal(r.route, 'consent');
});

test('flag rule: a config irreversible flag is irreversible', () => {
  const src =
    'module.exports = { config: { irreversible: true }, async up() {}, async down() {} };';
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [synthetic('6.56', '6.56/flag.js', src)],
  });
  assert.deepEqual(r.irreversible, [{ path: '6.56/flag.js', rule: 'flag' }]);
  assert.equal(r.route, 'consent');
});

test('helper rule: createIrreversibleMigration is irreversible', () => {
  const src = 'module.exports = createIrreversibleMigration(async () => {});';
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [synthetic('6.56', '6.56/helper.js', src)],
  });
  assert.deepEqual(r.irreversible, [{ path: '6.56/helper.js', rule: 'helper' }]);
});

test('a reversible migration in range is fast-path', () => {
  const r = classifyRange({ from: 'v6.55.0', to: 'v6.55.0', migrations: fixtures });
  assert.equal(r.filesInRange, 1);
  assert.equal(r.route, 'fast-path');
});

test('the pinned minor line is included, the line below is not', () => {
  const below = classifyRange({ from: 'v6.56.0', to: 'v6.69.0', migrations: fixtures });
  assert.equal(below.filesInRange, 2, 'folder 6.55 is below the pinned 6.56 line');
  const pinned = classifyRange({ from: 'v6.55.3', to: 'v6.55.3', migrations: fixtures });
  assert.equal(pinned.filesInRange, 1, 'a patch can add to its own minor folder');
});

test('a major bump is consent even with no irreversible migration', () => {
  const r = classifyRange({ from: 'v5.9.0', to: 'v6.0.0', migrations: [] });
  assert.equal(r.majorBump, true);
  assert.equal(r.route, 'consent');
});

test('a target older than the pinned release is refused', () => {
  assert.throws(
    () => classifyRange({ from: 'v6.55.0', to: 'v6.54.1', migrations: [] }),
    /precedes/
  );
});

test('an unrecognised migration folder fails loudly rather than being skipped', () => {
  assert.throws(
    () =>
      classifyRange({
        from: 'v6.0.0',
        to: 'v6.0.0',
        migrations: [synthetic('misc', 'misc/x.js', '')],
      }),
    /unrecognised migration folder/
  );
});

test('cli exits 2 for consent, 0 for fast-path, 1 for missing arguments', () => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const dir = join(here, 'fixtures', 'versions');
    assert.equal(main(['--from', 'v6.55.0', '--to', 'v6.69.0', '--versions', dir]), 2);
    assert.equal(main(['--from', 'v6.55.0', '--to', 'v6.55.0', '--versions', dir]), 0);
  } finally {
    process.stdout.write = write;
  }
  const err = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(main(['--from', 'v6.55.0']), 1);
  } finally {
    process.stderr.write = err;
  }
});

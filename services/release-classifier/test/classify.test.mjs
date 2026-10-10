import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyRange,
  CONSTRAINT_ROUTE,
  CONTRACTING_ROUTE,
  parseRelease,
} from '../src/classify.mjs';
import { readMigrations, main } from '../src/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = readMigrations(join(here, 'fixtures', 'versions'));
const sample = (folder, path, source) => ({ folder, path, source });
const pathsOf = (list) => list.map((x) => x.path);

const REVERSIBLE = "module.exports = combineTransactionalMigrations(addSetting({ key: 'x' }));";

test('parseRelease accepts plain tags and rejects prereleases', () => {
  assert.deepEqual(parseRelease('v6.55.0'), { major: 6, minor: 55, patch: 0 });
  assert.throws(() => parseRelease('v6.0.0-rc.2'), /not a plain release tag/);
});

test('the pinned constants are at their owner-pending values', () => {
  assert.equal(CONTRACTING_ROUTE, 'consent');
  assert.equal(CONSTRAINT_ROUTE, 'consent');
});

test('real fixtures, range 6.55.0 to 6.69.0: 6.0 is out of range, 6.58 and 6.63 destroy tables', () => {
  const r = classifyRange({ from: 'v6.55.0', to: 'v6.69.0', migrations: fixtures });
  assert.equal(r.filesInRange, 6);
  assert.equal(r.route, 'consent');
  assert.deepEqual(r.irreversible, []);
  assert.deepEqual(
    r.destructive.map((x) => `${x.path} ${x.rule}`).filter((s) => s.includes('delete-table')),
    [
      '6.58/2026-08-11-10-00-00-swap-custom-field-values-to-key-fk.js delete-table',
      '6.63/2026-09-03-10-07-03-rename-custom-field-tables-to-metafields.js delete-table',
    ]
  );
  assert.deepEqual([...new Set(pathsOf(r.contracting))].sort(), [
    '6.57/2026-08-04-18-00-00-store-custom-field-values-as-leaf-rows.js',
    '6.57/2026-08-04-18-54-14-reset-automation-email-analytics.js',
  ]);
  assert.deepEqual([...new Set(pathsOf(r.constraint))].sort(), [
    '6.55/2026-07-27-11-25-44-add-to-hash-to-redirects.js',
    '6.57/2026-08-04-18-00-00-store-custom-field-values-as-leaf-rows.js',
    '6.60/2026-08-20-10-52-59-add-gift-delivery-outcomes.js',
  ]);
});

test('v6.62.0 to v6.69.0 routes consent on the 6.63 table drop with a no-op rollback', () => {
  const r = classifyRange({ from: 'v6.62.0', to: 'v6.69.0', migrations: fixtures });
  assert.equal(r.route, 'consent');
  assert.deepEqual(r.destructive.map((x) => x.rule).sort(), ['delete-table', 'noop-rollback']);
});

test('control case: an irreversible migration in a non-newest folder of the range routes consent', () => {
  const r = classifyRange({
    from: 'v6.55.0',
    to: 'v6.58.0',
    migrations: [
      sample('6.57', '6.57/flag.js', 'module.exports = { config: { irreversible: true } };'),
    ],
  });
  assert.deepEqual(r.irreversible, [{ path: '6.57/flag.js', rule: 'flag' }]);
  assert.equal(r.route, 'consent');
});

test('flag rule: a config irreversible flag, bare or quoted', () => {
  for (const src of [
    'module.exports = { config: { irreversible: true } };',
    "module.exports = { config: { 'irreversible': true } };",
  ]) {
    const r = classifyRange({
      from: 'v6.56.0',
      to: 'v6.56.0',
      migrations: [sample('6.56', 'f.js', src)],
    });
    assert.deepEqual(r.irreversible, [{ path: 'f.js', rule: 'flag' }]);
    assert.equal(r.route, 'consent');
  }
});

test('helper rule: createIrreversibleMigration is irreversible', () => {
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [
      sample('6.56', 'h.js', 'module.exports = createIrreversibleMigration(async () => {});'),
    ],
  });
  assert.deepEqual(r.irreversible, [{ path: 'h.js', rule: 'helper' }]);
});

test('wrapper rule: the 6.0 dropTables migration is irreversible', () => {
  const r = classifyRange({ from: 'v6.0.0', to: 'v6.0.0', migrations: fixtures });
  assert.deepEqual(r.irreversible, [
    { path: '6.0/2025-06-30-13-59-10-remove-mail-events-table.js', rule: 'wrapper' },
  ]);
  assert.equal(r.route, 'consent');
});

test('the pinned minor folder is included: v6.0.0 to v6.1.0 routes consent on the 6.0 wrapper migration', () => {
  const r = classifyRange({ from: 'v6.0.0', to: 'v6.1.0', migrations: fixtures });
  assert.equal(r.route, 'consent');
  assert.ok(r.irreversible.some((x) => x.rule === 'wrapper'));
});

test('destructive rules: each named form is caught by its own rule', () => {
  const cases = {
    'delete-table': "await commands.deleteTable('x', knex);",
    'recreate-table': "await recreateTable('x', knex, {});",
    'raw-drop-table': `await knex.raw('${['DROP', 'TABLE', 'foo'].join(' ')}');`,
    'raw-delete-from': `await knex.raw('${['DELETE', 'FROM', 'foo', 'WHERE', '1'].join(' ')}');`,
    'raw-truncate': `await knex.raw('${['TRUNCATE', 'foo'].join(' ')}');`,
    'delete-call': "await knex('x').delete();",
    'del-with-argument': "await knex('x').del(trx);",
  };
  for (const [rule, code] of Object.entries(cases)) {
    const r = classifyRange({
      from: 'v6.56.0',
      to: 'v6.56.0',
      migrations: [sample('6.56', 'd.js', code)],
    });
    assert.ok(
      r.destructive.some((x) => x.rule === rule),
      `${rule} not matched`
    );
    assert.equal(r.route, 'consent', rule);
  }
});

test('noop-rollback: a no-op down with a destructive-looking call is destructive', () => {
  const src = `module.exports = createNonTransactionalMigration(
  async function up(knex) { await deleteRow(knex, 'x'); },
  async function down() {},
);`;
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [sample('6.56', 'n.js', src)],
  });
  assert.deepEqual(r.destructive, [{ path: 'n.js', rule: 'noop-rollback' }]);
});

test('a commented-out destructive call does not match the destructive rules', () => {
  const src = "// await commands.deleteTable('x', knex);\nmodule.exports = {};";
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [sample('6.56', 'c.js', src)],
  });
  assert.deepEqual(r.destructive, []);
});

test('a genuinely reversible migration is fast-path', () => {
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [sample('6.56', 'r.js', REVERSIBLE)],
  });
  assert.equal(r.filesInRange, 1);
  assert.equal(r.route, 'fast-path');
});

test('constraint drops are their own class and route consent under CONSTRAINT_ROUTE', () => {
  const r = classifyRange({
    from: 'v6.56.0',
    to: 'v6.56.0',
    migrations: [sample('6.56', 'k.js', "await dropForeign('t', ['c'], knex);")],
  });
  assert.deepEqual(r.constraint, [{ path: 'k.js', rule: 'drop-constraint' }]);
  assert.deepEqual(r.destructive, []);
  assert.equal(r.route, 'consent');
});

test('the pinned line is included, the line below is not', () => {
  const pinned = classifyRange({ from: 'v6.55.3', to: 'v6.55.3', migrations: fixtures });
  assert.equal(pinned.filesInRange, 1, 'a patch can add to its own minor folder');
  const below = classifyRange({ from: 'v6.56.0', to: 'v6.69.0', migrations: fixtures });
  assert.equal(below.filesInRange, 5, 'folder 6.55 is below the pinned 6.56 line');
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
        migrations: [sample('misc', 'misc/x.js', '')],
      }),
    /unrecognised migration folder/
  );
});

test('cli exits 2 for consent, 0 for fast-path, 1 for missing arguments', () => {
  const dir = join(here, 'fixtures', 'versions');
  const reversibleDir = mkdtempSync(join(tmpdir(), 'rc-'));
  mkdirSync(join(reversibleDir, '6.56'));
  writeFileSync(join(reversibleDir, '6.56', 'r.js'), REVERSIBLE);
  const quiet = (stream) => {
    const write = stream.write;
    stream.write = () => true;
    return () => {
      stream.write = write;
    };
  };
  const restoreOut = quiet(process.stdout);
  const restoreErr = quiet(process.stderr);
  try {
    assert.equal(main(['--from', 'v6.55.0', '--to', 'v6.69.0', '--versions', dir]), 2);
    assert.equal(main(['--from', 'v6.56.0', '--to', 'v6.56.0', '--versions', reversibleDir]), 0);
    assert.equal(main(['--from', 'v6.55.0']), 1);
  } finally {
    restoreOut();
    restoreErr();
  }
});

test('unknown helper call in a non-newest folder routes consent as unclassified', () => {
  const r = classifyRange({
    from: 'v6.55.0',
    to: 'v6.58.0',
    migrations: [
      sample(
        '6.57',
        '6.57/new.js',
        "module.exports = combineTransactionalMigrations(newHelper('x'));"
      ),
    ],
  });
  assert.deepEqual(r.unclassified, [{ path: '6.57/new.js', rule: 'unclassified:newHelper' }]);
  assert.equal(r.route, 'consent');
});

test('removeSetting routes consent as a destructive removal', () => {
  const src = "module.exports = combineTransactionalMigrations(removeSetting('routes_hash'));";
  const r = classifyRange({
    from: 'v6.55.0',
    to: 'v6.55.0',
    migrations: [sample('6.55', 'r.js', src)],
  });
  assert.deepEqual(r.destructive, [{ path: 'r.js', rule: 'remove-setting' }]);
  assert.equal(r.route, 'consent');
});

test('a helper the file declares itself is not unclassified', () => {
  const src = `function addPostsColumn(knex) { return createAddColumnMigration(knex, 'x'); }
module.exports = combineNonTransactionalMigrations(addPostsColumn);`;
  const r = classifyRange({
    from: 'v6.64.0',
    to: 'v6.64.0',
    migrations: [sample('6.64', 'p.js', src)],
  });
  assert.deepEqual(r.unclassified, []);
  assert.equal(r.route, 'fast-path');
});

test('the allowlist is fail-closed: update and raw are not on it', () => {
  for (const call of ['update', 'raw']) {
    const r = classifyRange({
      from: 'v6.67.0',
      to: 'v6.67.0',
      migrations: [sample('6.67', 'u.js', `await knex.${call}('x');`)],
    });
    assert.equal(r.route, 'consent', call);
  }
});

const one = (src) =>
  classifyRange({ from: 'v6.56.0', to: 'v6.56.0', migrations: [sample('6.56', 'a.js', src)] });

test('alias: a const alias of a wrapper is resolved, so the dropTables alias routes consent', () => {
  const r = one("const dropper = utils.dropTables;\nmodule.exports = dropper(['members']);");
  assert.deepEqual(r.irreversible, [{ path: 'a.js', rule: 'wrapper' }]);
  assert.equal(r.route, 'consent');
});

test('alias: a const alias of removeSetting routes consent as a destructive removal', () => {
  const r = one(
    "const removeIt = utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(removeIt('x'));"
  );
  assert.deepEqual(r.destructive, [{ path: 'a.js', rule: 'remove-setting' }]);
  assert.equal(r.route, 'consent');
});

test('destructured: const { removeSetting } = utils routes consent', () => {
  const r = one(
    "const { removeSetting } = utils;\nmodule.exports = combineTransactionalMigrations(removeSetting('x'));"
  );
  assert.equal(r.route, 'consent');
  assert.ok(r.destructive.some((x) => x.rule === 'remove-setting'));
});

test('an alias bound to a computed member is unresolvable and routes consent', () => {
  const r = one("const f = utils[name];\nmodule.exports = combineTransactionalMigrations(f('x'));");
  assert.deepEqual(r.unclassified, [{ path: 'a.js', rule: 'unclassified:f' }]);
  assert.equal(r.route, 'consent');
});

test('a parameter called as a function is unclassified', () => {
  const r = one(
    "function run(helper) { return helper('x'); }\nmodule.exports = combineTransactionalMigrations(run);"
  );
  assert.ok(r.unclassified.some((x) => x.rule === 'unclassified:helper'));
  assert.equal(r.route, 'consent');
});

test('an alias written twice is ambiguous and routes consent', () => {
  const r = one("let f = utils.addTable;\nf = utils.dropTables;\nmodule.exports = f('x');");
  assert.equal(r.route, 'consent');
});

test('control: a local arrow helper that calls only allowlisted helpers stays fast-path', () => {
  const r = one(
    "const addCol = (n) => createAddColumnMigration('t', n);\nmodule.exports = combineNonTransactionalMigrations(addCol('x'));"
  );
  assert.deepEqual(r.unclassified, []);
  assert.equal(r.route, 'fast-path');
});

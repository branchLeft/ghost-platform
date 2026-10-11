import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyRange,
  classifySource,
  CONSTRAINT_ROUTE,
  CONTRACTING_ROUTE,
  parseRelease,
} from '../src/classify.mjs';
import { readMigrations, main } from '../src/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = readMigrations(join(here, 'fixtures', 'versions'));
const fastPathFixtures = readMigrations(join(here, 'fixtures', 'fast-path'));
const sample = (folder, path, source) => ({ folder, path, source });
const pathsOf = (list) => list.map((x) => x.path);

// Every source below that should be able to reach fast-path starts with this
// import preamble: a call is fast-path only through a name the file imported.
const HEAD = [
  'const {',
  '  combineTransactionalMigrations,',
  '  combineNonTransactionalMigrations,',
  '  createTransactionalMigration,',
  '  createAddColumnMigration,',
  '  addSetting,',
  "} = require('../../utils');",
  "const utils = require('../../utils');",
  '',
].join('\n');

const REVERSIBLE = `${HEAD}module.exports = combineTransactionalMigrations(addSetting({ key: 'x' }));`;

const one = (src) =>
  classifyRange({ from: 'v6.56.0', to: 'v6.56.0', migrations: [sample('6.56', 'a.js', src)] });
const reasons = (r) => r.unclassified.map((x) => x.rule);
const hitRules = (r) => [
  ...r.irreversible.map((x) => x.rule),
  ...r.destructive.map((x) => x.rule),
  ...r.contracting.map((x) => x.rule),
  ...r.constraint.map((x) => x.rule),
];
const assertFast = (src, why) => {
  const r = one(src);
  assert.equal(r.route, 'fast-path', `${why ?? 'expected fast-path'}: ${JSON.stringify(r)}`);
};
const assertConsent = (src, why) => {
  const r = one(src);
  assert.equal(r.route, 'consent', `${why ?? 'expected consent'}: ${JSON.stringify(r)}`);
  return r;
};
const migration = (up, down = '') =>
  `${HEAD}module.exports = createTransactionalMigration(\n` +
  `  async function up(knex) {\n${up}\n  },\n` +
  `  async function down(knex) {\n${down}\n  }\n);`;

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

test('real fast-path files: 19 of the 22 stay fast-path under the positive grammar', () => {
  const calledLocalHelper = new Map([
    ['6.59/2026-08-18-17-06-46-add-gift-delivery-fields-to-gifts.js', 'unclassified:addGiftColumn'],
    [
      '6.64/2026-09-08-11-01-12-add-posts-auto-excerpt-and-reading-time-columns.js',
      'unclassified:addPostsColumn',
    ],
    ['6.68/2026-10-01-09-08-09-add-email-recipient-accounting.js', 'unclassified:addColumn'],
  ]);
  assert.equal(fastPathFixtures.length, 22);
  let fast = 0;
  for (const m of fastPathFixtures) {
    const r = classifyRange({ from: 'v6.55.0', to: 'v6.69.0', migrations: [m] });
    assert.equal(r.filesInRange, 1, m.path);
    const expected = calledLocalHelper.get(m.path);
    if (expected === undefined) {
      assert.equal(r.route, 'fast-path', `${m.path}: ${JSON.stringify(r)}`);
      fast += 1;
    } else {
      assert.equal(r.route, 'consent', m.path);
      assert.deepEqual(reasons(r), [expected], m.path);
    }
  }
  assert.equal(fast, 19);
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
    'drop-development-copy': "await dropDevelopmentCopy('x', knex);",
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

test('noop-rollback: a down that only logs counts as a no-op; one that does work does not', () => {
  const logOnly = `module.exports = {
  async up(knex) { await removeRow(knex); },
  async down() { logging.warn('not reversible'); },
};`;
  const works = `module.exports = {
  async up(knex) { await removeRow(knex); },
  async down(knex) { await knex('t').where('a', 1); },
};`;
  assert.deepEqual(one(logOnly).destructive, [{ path: 'a.js', rule: 'noop-rollback' }]);
  assert.deepEqual(one(works).destructive, []);
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

test('contracting rules: each named form is caught by its own rule', () => {
  const cases = {
    'drop-column': "await dropColumn('t', 'c', knex);",
    'remove-permission': "await removePermissionFromRole({ permission: 'p', role: 'r' });",
    'data-delete': "await knex('x').del();",
  };
  for (const [rule, code] of Object.entries(cases)) {
    const r = one(code);
    assert.ok(
      r.contracting.some((x) => x.rule === rule),
      `${rule} not matched`
    );
    assert.equal(r.route, 'consent', rule);
  }
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

test('cli exits 0 for fast-path, 2 for the consent verdict, 1 for an error', () => {
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
        `${HEAD}module.exports = combineTransactionalMigrations(newHelper('x'));`
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

test('a helper the file declares itself, passed by reference, is not unclassified', () => {
  const src = `${HEAD}function addPostsColumn(knex) { return createAddColumnMigration(knex, 'x'); }
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
    const r = assertConsent(migration(`    await knex('t').${call}('x');`), call);
    assert.deepEqual(reasons(r), [`unclassified:${call}`], call);
  }
  const viaHandle = assertConsent(migration("    await knex.raw('x');"));
  assert.deepEqual(reasons(viaHandle), ['unclassified:raw']);
});

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

test('an alias bound to a computed member is refused at the computed access', () => {
  const r = one(
    `${HEAD}const f = utils[name];\nmodule.exports = combineTransactionalMigrations(f('x'));`
  );
  assert.deepEqual(reasons(r), ['unclassified:[']);
  assert.equal(r.route, 'consent');
});

test('a parameter called as a function is unclassified', () => {
  const r = one(
    `${HEAD}function run(helper) { return helper('x'); }\nmodule.exports = combineTransactionalMigrations(run);`
  );
  assert.deepEqual(reasons(r), ['unclassified:helper']);
  assert.equal(r.route, 'consent');
});

test('an alias written twice is ambiguous and routes consent', () => {
  const r = one("let f = utils.addTable;\nf = utils.dropTables;\nmodule.exports = f('x');");
  assert.equal(r.route, 'consent');
});

test('a local arrow helper is fast-path when passed by reference and consent when called by name', () => {
  const byRef = `${HEAD}const addCol = (n) => createAddColumnMigration('t', n, { type: 'string' });
module.exports = combineNonTransactionalMigrations(...['x', 'y'].map(addCol));`;
  assertFast(byRef, 'a local helper handed to map is checked by its body');
  const byName = `${HEAD}const addCol = (n) => createAddColumnMigration('t', n, { type: 'string' });
module.exports = combineNonTransactionalMigrations(addCol('x'));`;
  const r = assertConsent(byName, 'a local name used as a callee');
  assert.deepEqual(reasons(r), ['unclassified:addCol']);
});

// The six fail-open classes from the cycle-4 review. Each plain-form control
// routes the way it did before; each evasion now routes consent.

test('class 1: an optional call routes consent, as the plain call does', () => {
  const control = assertConsent(
    `${HEAD}module.exports = utils.removeSetting('members_legacy_flag');`
  );
  assert.deepEqual(hitRules(control), ['remove-setting']);
  assert.deepEqual(reasons(control), ['unclassified:removeSetting']);

  const forms = {
    'utils.removeSetting?.(': ["module.exports = utils.removeSetting?.('k');", 'remove-setting'],
    'dropTables?.(': ["module.exports = utils.dropTables?.(['t']);", 'wrapper'],
    'knex.schema.dropTable?.(': ["    await knex.schema.dropTable?.('t');", null],
    'knex.raw?.(': ["    await knex.raw?.('x');", null],
    '?. on an allowlisted helper': ["module.exports = utils?.addSetting?.({ key: 'a' });", null],
  };
  for (const [label, [body, rule]] of Object.entries(forms)) {
    const src = body.startsWith('module.exports') ? `${HEAD}${body}` : migration(body);
    const r = assertConsent(src, label);
    if (rule !== null) assert.ok(hitRules(r).includes(rule), label);
    assert.ok(r.unclassified.length > 0, label);
  }
});

test('class 2: a helper passed by reference, not called, is a hit', () => {
  const control = assertConsent(
    `${HEAD}const { removeSetting } = require('../../utils');\nmodule.exports = combineTransactionalMigrations(...['a'].map((key) => removeSetting(key)));`
  );
  assert.deepEqual(hitRules(control), ['remove-setting']);

  const mapped = assertConsent(
    `const { combineTransactionalMigrations, removeSetting } = require('../../utils');\nconst KEYS = ['one_key', 'two_key'];\nmodule.exports = combineTransactionalMigrations(...KEYS.map(removeSetting));`
  );
  assert.deepEqual(hitRules(mapped), ['remove-setting']);

  const dropped = assertConsent(
    `${HEAD}module.exports = combineTransactionalMigrations(...['a'].map(utils.dropTables));`
  );
  assert.deepEqual(hitRules(dropped), ['wrapper']);
});

test('class 3: a local name never exempts a member call of the same name', () => {
  const control = assertConsent(migration("    await knex('members').update({ email: null });"));
  assert.deepEqual(reasons(control), ['unclassified:update']);

  for (const name of ['update', 'raw', 'dropTable', 'renameTable', 'alterTable']) {
    const src = `${HEAD}const ${name} = 1;\nmodule.exports = createTransactionalMigration(\n  async function up(knex) {\n    await knex('members').${name}({ email: null });\n  },\n  async function down(knex) {}\n);`;
    const r = assertConsent(src, name);
    assert.deepEqual(reasons(r), [`unclassified:${name}`], name);
  }

  const helperBody = `${HEAD}const update = async (knex) => {\n  await knex('settings').update({ value: null });\n};\nmodule.exports = createTransactionalMigration(\n  async function up(knex) {\n    await knex('members').update({ email: null });\n  },\n  async function down(knex) {\n    await knex('members').where('id', 1);\n  }\n);`;
  assertConsent(helperBody, 'a local helper named update');
});

test('class 4: no write to a name is accepted, whatever the name was bound to', () => {
  const forms = {
    'literal then reassigned': `${HEAD}let h = 0;\nh = utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(h('some_key'));`,
    'function then reassigned': `${HEAD}function h() {}\nh = utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(h('some_key'));`,
    'logical-and assignment': `${HEAD}let make = utils.addSetting;\nmake &&= utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(make('some_key'));`,
    'logical-or assignment': `${HEAD}let make = utils.addSetting;\nmake ||= utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(make('some_key'));`,
    'nullish assignment': `${HEAD}let make = utils.addSetting;\nmake ??= utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(make('some_key'));`,
    'destructuring assignment': `${HEAD}let make = utils.addSetting;\n({ removeSetting: make } = utils);\nmodule.exports = combineTransactionalMigrations(make('some_key'));`,
  };
  for (const [label, src] of Object.entries(forms)) {
    const r = assertConsent(src, label);
    assert.ok(
      r.destructive.some((x) => x.rule === 'remove-setting'),
      label
    );
  }
});

test('class 4: with no destructive name present, an assignment alone still routes consent', () => {
  const forms = {
    plain: `${HEAD}let k = 'a';\nk = 'b';\nmodule.exports = addSetting({ key: k });`,
    compound: `${HEAD}let n = 1;\nn += 1;\nmodule.exports = addSetting({ key: 'a', value: n });`,
    increment: `${HEAD}let n = 1;\nn++;\nmodule.exports = addSetting({ key: 'a', value: n });`,
    'function name': `${HEAD}function h() {}\nh = utils.addSetting;\nmodule.exports = combineTransactionalMigrations(h({ key: 'k' }));`,
    'member write': `${HEAD}const o = {};\no.k = 1;\nmodule.exports = addSetting({ key: 'a' });`,
  };
  for (const [label, src] of Object.entries(forms)) assertConsent(src, label);
  assertFast(`${HEAD}let k = 'a';\nmodule.exports = addSetting({ key: k });`, 'let bound once');
});

test('class 5: a non-ASCII identifier makes the file unclassified', () => {
  const control = assertConsent(
    `${HEAD}const cafe = utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(cafe('k'));`
  );
  assert.deepEqual(hitRules(control), ['remove-setting']);

  const forms = [
    `${HEAD}const café = utils.removeSetting;\nmodule.exports = combineTransactionalMigrations(café('some_key'));`,
    "const ñ = require('../../utils').dropTables;\nmodule.exports = ñ(['mail_events']);",
    `${HEAD}const café = utils.addSetting;\nmodule.exports = combineTransactionalMigrations(café({ key: 'a' }));`,
    `${HEAD}module.exports = addSetting({ key: 'a' }, removeSettingé);`,
  ];
  for (const src of forms) {
    const r = assertConsent(src);
    assert.deepEqual(reasons(r), ['unclassified:non-ascii-identifier']);
  }
  assertFast(
    `${HEAD}// café ñ\nmodule.exports = addSetting({ key: 'café', value: 'ñ' });`,
    'non-ASCII in text'
  );
});

test('class 6: a comment marker inside a string cannot hide code', () => {
  const glob = `const { combineTransactionalMigrations, removeSetting } = require('../../utils');\n\nconst GLOB = '/content/images/*';\n\nmodule.exports = combineTransactionalMigrations(\n  removeSetting('legacy_key'),\n);\n\n/**\n * Registered paths use GLOB.\n */\n`;
  const r = assertConsent(glob, 'glob string then a doc comment');
  assert.deepEqual(hitRules(r), ['remove-setting']);
  const withoutGlob = glob.replace("const GLOB = '/content/images/*';\n\n", '');
  assert.deepEqual(hitRules(one(withoutGlob)), ['remove-setting'], 'the control');

  const forms = {
    'block opener in a line comment': `${HEAD}// see /* here\nmodule.exports = combineTransactionalMigrations(utils.removeSetting('k'));\n/* end */\n`,
    'regex holding a quote': `${HEAD}const re = /'/;\nmodule.exports = combineTransactionalMigrations(utils.removeSetting('t'));\nconst w = '';\n`,
    'backtick in a trailing comment': `${HEAD}module.exports = combineTransactionalMigrations(utils.removeSetting('t')); // a \` here\nconst w = \`\`;\n`,
    'call inside a template substitution': `${HEAD}const msg = \`\${utils.removeSetting('t')}\`;\nmodule.exports = addSetting({ key: 'a' });\n`,
  };
  for (const [label, src] of Object.entries(forms)) {
    const result = assertConsent(src, label);
    assert.ok(hitRules(result).includes('remove-setting'), label);
  }
  assertFast(
    `${HEAD}const GLOB = '/content/images/*';\nmodule.exports = addSetting({ key: 'a', value: GLOB });\n\n/**\n * Doc.\n */\n`,
    'a clean file with a glob string and a doc comment'
  );
});

test('an empty file, a comment-only file and a syntax-error file route consent', () => {
  const forms = {
    empty: ['', 'unclassified:unlexable'],
    'whitespace only': ['  \n\n', 'unclassified:unlexable'],
    'comment only': ['// nothing\n/* here */\n', 'unclassified:unlexable'],
    'syntax error': [`${HEAD}module.exports = addSetting({ key: ;`, 'unclassified:syntax'],
    'unterminated string': [
      `${HEAD}module.exports = addSetting({ key: 'a });`,
      'unclassified:unlexable',
    ],
    'unterminated block comment': [`${HEAD}/* open`, 'unclassified:unlexable'],
    'unterminated template': [`${HEAD}const t = \`abc`, 'unclassified:unlexable'],
    hashbang: [`#!/usr/bin/env node\n${REVERSIBLE}`, 'unclassified:unlexable'],
  };
  for (const [label, [src, reason]] of Object.entries(forms)) {
    const r = assertConsent(src, label);
    assert.deepEqual(reasons(r), [reason], label);
  }
});

test('a module that re-exports a sibling is unclassified, not passed through', () => {
  const r = assertConsent("module.exports = require('./sibling');");
  assert.deepEqual(reasons(r), ['unclassified:require:./sibling']);
});

test('adversarial: ?. is refused after every hit name and after an allowlisted one', () => {
  for (const name of [
    'removeSetting',
    'dropTables',
    'dropTable',
    'raw',
    'del',
    'delete',
    'truncate',
  ]) {
    for (const form of [`utils.${name}?.('k')`, `${name}?.('k')`, `knex.${name}?.('k')`]) {
      assertConsent(`${HEAD}module.exports = ${form};`, form);
    }
  }
  assertConsent(`${HEAD}module.exports = utils.addSetting?.({ key: 'a' });`);
});

test('adversarial: computed access, bind, call, apply and Reflect.apply route consent', () => {
  const forms = [
    "utils['removeSetting']('k')",
    'utils[`removeSetting`]("k")',
    "utils.addSetting.bind(null, { key: 'a' })()",
    "utils.addSetting.call(null, { key: 'a' })",
    "utils.addSetting.apply(null, [{ key: 'a' }])",
    "Reflect.apply(utils.addSetting, null, [{ key: 'a' }])",
    "(0, utils.addSetting)({ key: 'a' })",
    "[utils.addSetting][0]({ key: 'a' })",
    "new utils.addSetting({ key: 'a' })",
    "import('../../utils')",
    "eval('1')",
  ];
  for (const form of forms) assertConsent(`${HEAD}module.exports = ${form};`, form);
});

test('adversarial: an object spread of the utils module cannot reach a helper', () => {
  assertConsent(
    `${HEAD}const copy = { ...utils };\nmodule.exports = copy.addSetting({ key: 'a' });`
  );
  const r = assertConsent(
    `${HEAD}const copy = { ...utils };\nmodule.exports = copy.removeSetting('k');`
  );
  assert.ok(hitRules(r).includes('remove-setting'));
  assertFast(
    `${HEAD}const base = { type: 'string' };\nmodule.exports = addSetting({ ...base, key: 'a' });`
  );
});

test('adversarial: template literal and regex shapes are lexed, not guessed', () => {
  assertFast(
    `${HEAD}module.exports = addSetting({ key: \`}\` + '\`' + \`/*\` });`,
    'braces, a backtick and /* in text'
  );
  const sub = assertConsent(
    `${HEAD}module.exports = addSetting({ key: \`a\${removeSetting}b\` });`
  );
  assert.ok(hitRules(sub).includes('remove-setting'));
  const rx = assertConsent(
    `${HEAD}const re = /\\/\\/'"/;\nmodule.exports = addSetting({ key: 'a' });`
  );
  assert.deepEqual(reasons(rx), ['unclassified:regex']);
  assertFast(
    `${HEAD}const half = (10 + 2) / 2 / 3;\nmodule.exports = addSetting({ key: 'a', value: half });`,
    'division'
  );
  const ambiguous = assertConsent(
    `${HEAD}const x = {}\n/re/g.test('a');\nmodule.exports = addSetting({ key: 'a' });`
  );
  assert.deepEqual(reasons(ambiguous), ['unclassified:unlexable']);
});

test('adversarial: file-shape noise does not change the route', () => {
  assertFast(`${REVERSIBLE}\n//# sourceMappingURL=r.js.map\n`, 'a source map trailer');
  assertFast(REVERSIBLE.replace(/\n/g, '\r\n'), 'CRLF line endings');
  assertFast(`\ufeff${REVERSIBLE}`, 'a byte order mark');
  assertFast(
    "const{combineTransactionalMigrations:c,addSetting:a}=require('../../utils');module.exports=c(a({key:'k',value:null}));",
    'a minified one-liner'
  );
  const bad = assertConsent(
    "const{combineTransactionalMigrations:c,removeSetting:a}=require('../../utils');module.exports=c(a('k'));",
    'a minified one-liner with a removal'
  );
  assert.deepEqual(hitRules(bad), ['remove-setting']);
});

test('adversarial: a unicode-escaped identifier is unlexable', () => {
  const r = assertConsent(`${HEAD}module.exports = utils.\\u0072emoveSetting('k');`);
  assert.deepEqual(reasons(r), ['unclassified:unlexable']);
});

test('adversarial: getters, classes, generators, async and await', () => {
  const getter = assertConsent(
    `${HEAD}module.exports = { get up() { return utils.removeSetting('k'); } };`
  );
  assert.ok(hitRules(getter).includes('remove-setting'));
  assertConsent(`${HEAD}module.exports = { get up() { return 1; } };`, 'a getter alone');
  const klass = assertConsent(
    `${HEAD}class M { up() { return utils.removeSetting('k'); } }\nmodule.exports = M;`
  );
  assert.ok(hitRules(klass).includes('remove-setting'));
  assertConsent(`${HEAD}class M { up() { return 1; } }\nmodule.exports = M;`, 'a class alone');
  assertConsent(`${HEAD}function* g() { yield 1; }\nmodule.exports = addSetting({ key: 'a' });`);
  assertFast(
    migration(
      "    await knex('a').where('b', 1).whereNull('c');",
      "    await knex('a').where('b', 1);"
    ),
    'async functions with awaited reads'
  );
  assertConsent(
    `${HEAD}module.exports = createTransactionalMigration(function up(knex) { return await knex('a').where('b', 1); }, function down(knex) {});`,
    'await in a function that is not async'
  );
});

test('adversarial: a tagged template or a newline continuation cannot hide a call', () => {
  assertConsent(`${HEAD}module.exports = utils.addSetting\`x\`;`);
  assertConsent(
    migration('    knex\n`x`;').replace('async function up(knex)', 'async function up(db)'),
    'tagged template on a parameter'
  );
  assertConsent(
    `${HEAD}const k = utils\n['removeSetting'];\nmodule.exports = addSetting({ key: 'a' });`
  );
});

test('adversarial: hit names in comments and strings do not count', () => {
  const comments = `${HEAD}// removeSetting dropTables createIrreversibleMigration deleteTable irreversible: true\n/* removeSetting('k'); knex.raw('x'); */\nmodule.exports = addSetting({ key: 'a' });`;
  const rc = one(comments);
  assert.equal(rc.route, 'fast-path', JSON.stringify(rc));
  assert.deepEqual(hitRules(rc), []);
  const strings = `${HEAD}module.exports = addSetting({ key: 'removeSetting', value: 'dropTables', type: 'createIrreversibleMigration' });`;
  const rs = one(strings);
  assert.equal(rs.route, 'fast-path', JSON.stringify(rs));
  assert.deepEqual(hitRules(rs), []);
  const spelled = `${HEAD}module.exports = addSetting({ key: 'a', value: '${['DROP', 'TABLE', 'x'].join(' ')}' });`;
  assert.deepEqual(hitRules(one(spelled)), ['raw-drop-table']);
  const escaped = `${HEAD}module.exports = addSetting({ key: 'a', value: 'DROP\\x20TABLE x' });`;
  assert.deepEqual(hitRules(one(escaped)), ['raw-drop-table']);
});

test('adversarial: a name that is not on the allowlist is never callable', () => {
  const forms = {
    'bare method name': `${HEAD}module.exports = where('a', 1);`,
    'method as a bare import':
      "const { where } = require('../../utils');\nmodule.exports = where('a', 1);",
    'helper as a method of a value': `${HEAD}const o = {};\nmodule.exports = o.addSetting({ key: 'a' });`,
    'require of an unknown module': "const fs = require('fs');\nmodule.exports = fs;",
    'a global': `${HEAD}module.exports = process.exit(1);`,
    'a runtime handle outside a migration function': `${HEAD}const run = (knex) => knex('a');\nmodule.exports = createTransactionalMigration(run);`,
  };
  for (const [label, src] of Object.entries(forms)) assertConsent(src, label);
});

test('classifySource reports one entry per class and never throws on odd input', () => {
  const r = classifySource(`${HEAD}module.exports = utils.dropTables(['a']);`);
  assert.deepEqual(r.irreversible, ['wrapper']);
  for (const src of ['\0', '}}}', '`${', '/', 'a'.repeat(2_000_000)]) {
    assert.ok(classifySource(src).unclassified.length > 0, JSON.stringify(src.slice(0, 10)));
  }
  assert.ok(classifySource('('.repeat(50_000)).unclassified.length > 0);
});

// Ghost's runner refuses a rollback when `config.irreversible` is truthy, not
// only when it is the literal `true`. The grammar accepts the key only with the
// literal `false` as its whole value.
test('irreversible flag: every spelling but the literal false is refused', () => {
  const entry = 'up: async function up(config) {}, down: async function down() {}';
  const configOf = (value) => `module.exports = { config: { irreversible: ${value} }, ${entry} };`;
  const spread =
    "const { addSetting } = require('../../utils');\n" +
    "module.exports = { ...addSetting({ key: 'announcement', value: null, type: 'string', group: 'core' }), " +
    'config: { transaction: true, irreversible: !0 } };';
  const forms = {
    'number one': configOf('1'),
    'negated zero': configOf('!0'),
    'parenthesised true': configOf('(true)'),
    'shorthand over a constant': `const irreversible = 1;\nmodule.exports = { config: { irreversible }, ${entry} };`,
    'inside a spread config': spread,
    'quoted key, negated false': `module.exports = { config: { 'irreversible': !false }, ${entry} };`,
    'logical expression': configOf('1 && 1'),
    'a constant holding true': `const yes = true;\nmodule.exports = { config: { irreversible: yes }, ${entry} };`,
    'false followed by an operator': configOf('false || true'),
    'spread of a literal that carries the key': `const base = { irreversible: !0 };\nmodule.exports = { config: { ...base }, ${entry} };`,
  };
  for (const [label, src] of Object.entries(forms)) {
    const r = assertConsent(src, label);
    assert.ok(
      reasons(r).includes('unclassified:irreversible'),
      `${label}: ${JSON.stringify(reasons(r))}`
    );
  }
  const literalTrue = assertConsent(configOf('true'), 'literal true');
  assert.deepEqual(hitRules(literalTrue), ['flag']);
  assertFast(configOf('false'), 'control: the literal false');
  assertFast(`module.exports = { config: { 'irreversible': false }, ${entry} };`, 'quoted false');
});

test('an empty folder in range is the fast path; no folder in range is refused', () => {
  const empty = classifyRange({
    from: 'v6.70.0',
    to: 'v6.70.0',
    migrations: [],
    folders: ['6.70'],
  });
  assert.equal(empty.route, 'fast-path');
  assert.equal(empty.filesInRange, 0);
  const wider = classifyRange({
    from: 'v6.69.0',
    to: 'v6.70.0',
    migrations: [],
    folders: ['6.70'],
  });
  assert.equal(wider.route, 'fast-path');
  for (const folders of [[], ['6.69'], ['6.71']]) {
    assert.throws(
      () => classifyRange({ from: 'v6.70.0', to: 'v6.70.0', migrations: [], folders }),
      /no migration folder lies in the range/,
      JSON.stringify(folders)
    );
  }
});

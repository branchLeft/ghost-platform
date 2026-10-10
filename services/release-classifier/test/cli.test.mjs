import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readMigrations, readTree } from '../src/cli.mjs';

const REVERSIBLE =
  "const { addSetting } = require('../../utils');\n" +
  "module.exports = addSetting({ key: 'x', value: null, type: 'string', group: 'core' });\n";
const DROPS =
  "module.exports = { async up(c) { await c.connection.schema.dropTable('members'); }, async down() {} };\n";

// A versions tree in a temp directory: { '6.70': { 'a.js': 'source', sub: { 'index.js': '' } } }.
function tree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'rc-tree-'));
  const write = (dir, entries) => {
    for (const [name, value] of Object.entries(entries)) {
      const path = join(dir, name);
      if (typeof value === 'string') writeFileSync(path, value);
      else {
        mkdirSync(path);
        write(path, value);
      }
    }
  };
  write(root, spec);
  return root;
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
const cli = (dir, from = 'v6.69.0', to = 'v6.70.0') =>
  run(['--from', from, '--to', to, '--versions', dir]);

test('control: a normal tree still classifies, fast-path and consent', () => {
  const ok = tree({ '6.70': { '2026-10-01-00-00-00-add.js': REVERSIBLE } });
  const r = cli(ok);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).filesInRange, 1);
  const bad = tree({ '6.70': { '2026-10-01-00-00-00-drop.js': DROPS } });
  assert.equal(cli(bad).code, 2);
});

test('dot entries are skipped, as the runner skips them', () => {
  const dir = tree({
    '.gitkeep': '',
    '6.70': { '.DS_Store': '', 'a.js': REVERSIBLE },
  });
  assert.equal(cli(dir).code, 0);
});

test('every entry the runner would load that is not a regular .js file is refused', () => {
  const hidden = {
    '.cjs file': { 'x.cjs': DROPS },
    '.txt file': { 'x.txt': DROPS },
    'extensionless file': { x: DROPS },
    '.ts file': { 'x.ts': DROPS },
    '.JS file': { 'x.JS': DROPS },
    'directory with an index': { x: { 'index.js': DROPS } },
    'empty directory': { x: {} },
  };
  for (const [label, entries] of Object.entries(hidden)) {
    const dir = tree({ '6.70': { 'a.js': REVERSIBLE, ...entries } });
    assert.throws(() => readTree(dir), /runner would load/, label);
    const r = cli(dir);
    assert.equal(r.code, 1, label);
    assert.match(r.err, /release-classifier: entry the runner would load/, label);
    assert.equal(r.out, '', `${label}: nothing classified`);
  }
});

test('a symbolic link named like a migration is refused', () => {
  const dir = tree({ '6.70': { 'a.js': REVERSIBLE } });
  symlinkSync(join(dir, '6.70', 'a.js'), join(dir, '6.70', 'b.js'));
  assert.throws(() => readTree(dir), /runner would load/);
  assert.equal(cli(dir).code, 1);
});

test('an empty versions directory, or one with only dot entries, is refused', () => {
  for (const spec of [{}, { '.gitkeep': '' }]) {
    const dir = tree(spec);
    assert.throws(() => readTree(dir), /no version folder/);
    const r = cli(dir);
    assert.equal(r.code, 1);
    assert.match(r.err, /no version folder/);
    assert.equal(r.out, '');
  }
});

test('a stray file or a non-version directory in the versions directory is refused', () => {
  for (const spec of [
    { 'README.md': 'x', '6.70': {} },
    { init: {}, '6.70': {} },
  ]) {
    const dir = tree(spec);
    assert.throws(() => readTree(dir), /unexpected entry/);
    assert.equal(cli(dir).code, 1);
  }
});

test('a range with no version folder in it is refused, not read as fast-path', () => {
  const dir = tree({ 6.56: { 'a.js': DROPS }, 6.61: { 'b.js': REVERSIBLE } });
  for (const [from, to] of [
    ['v6.62.0', 'v6.62.1'],
    ['v6.57.0', 'v6.60.0'],
    ['v6.70.0', 'v6.70.3'],
  ]) {
    const r = cli(dir, from, to);
    assert.equal(r.code, 1, `${from} to ${to}`);
    assert.match(r.err, /no migration folder lies in the range/);
    assert.equal(r.out, '');
  }
  assert.equal(cli(dir, 'v6.61.0', 'v6.62.0').code, 0, 'a folder in range classifies');
});

test('an empty folder inside the range is a folder in range', () => {
  const dir = tree({ '6.70': {} });
  const r = cli(dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).filesInRange, 0);
});

test('readMigrations still returns the migration list', () => {
  const dir = tree({ '6.70': { 'a.js': REVERSIBLE, 'b.js': DROPS } });
  const list = readMigrations(dir);
  assert.deepEqual(list.map((m) => m.path).sort(), ['6.70/a.js', '6.70/b.js']);
});

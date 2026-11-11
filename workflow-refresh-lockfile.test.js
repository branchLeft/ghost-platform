// refresh-lockfile.yml runs a pull request's own files with a package-read
// token and hands a lockfile back. These checks pin what a mistake there would
// break without a failing run to notice: it must start on pull_request alone,
// skip a fork, hold read-only permissions and write nothing, never expand an
// expression inside a shell line, and select the right projects. The selector
// script is run against a fixture tree, not reimplemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const FILE = path.join(ROOT, '.github', 'workflows', 'refresh-lockfile.yml');
const SELECTOR = path.join(ROOT, 'scripts', 'select-lockfile-projects.py');
const body = fs.readFileSync(FILE, 'utf-8').replace(/^[ \t]*#.*$/gm, '');

// Every `run: |` block, dedented, with the step name that owns it.
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let stepName = '';
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\s*- name: (.*)$/);
    if (name) stepName = name[1].trim();
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) {
      const out = [];
      let base = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') {
          out.push('');
          continue;
        }
        const indent = lines[j].match(/^ */)[0].length;
        if (base === null) base = indent;
        if (indent < base) break;
        out.push(lines[j].slice(base));
      }
      blocks.push({ stepName, script: out.join('\n') });
    }
  }
  return blocks;
}

function jobText(name) {
  const start = body.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} exists`);
  const rest = body.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function select(root, changed) {
  const result = spawnSync('python3', ['-I', SELECTOR, '--root', root], {
    input: changed.join('\0'),
    encoding: 'utf-8',
  });
  return { status: result.status, projects: result.stdout ? JSON.parse(result.stdout) : null };
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'select-lockfile-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const manifest = (deps, extra = {}) =>
  JSON.stringify({ name: 'x', packageManager: 'pnpm@11.17.0', ...extra, dependencies: deps });

test('starts on pull_request alone, never pull_request_target', () => {
  const on = body.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m);
  assert.ok(on, 'has an on: block');
  const triggers = [...on[1].matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(triggers, ['pull_request']);
  assert.doesNotMatch(body, /pull_request_target/);
  assert.match(on[1], /'\*\*\/package\.json'/);
});

test('both jobs skip a pull request from a fork', () => {
  const guard = 'github.event.pull_request.head.repo.full_name == github.repository';
  assert.ok(jobText('select').includes(`if: ${guard}`));
  const refresh = jobText('refresh');
  assert.match(refresh, /needs: select/);
  // The refresh job inherits the skip from `select`; its own `if` only adds one.
  assert.match(refresh, /if: needs\.select\.outputs\.projects != '\[\]'/);
});

test('holds read-only permissions and writes nothing', () => {
  assert.match(body, /^permissions: \{\}$/m);
  assert.doesNotMatch(body, /:\s*write\b/);
  assert.doesNotMatch(body, /id-token/);
  assert.match(jobText('select'), /permissions:\n {6}contents: read\n(?! {6}\S)/);
  assert.match(jobText('refresh'), /permissions:\n {6}contents: read\n {6}packages: read\n/);
  for (const forbidden of [
    'git commit',
    'git push',
    'git add',
    'createCommitOnBranch',
    'gh api',
    'gh pr',
  ]) {
    assert.ok(!body.includes(forbidden), `must not contain: ${forbidden}`);
  }
});

test('uses only the run token and persists no credential', () => {
  const secrets = [...body.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.ok(
    secrets.every((s) => s === 'GITHUB_TOKEN'),
    `unexpected secret: ${secrets}`
  );
  const checkouts = body.match(/actions\/checkout@/g).length;
  assert.equal(body.match(/persist-credentials: false/g).length, checkouts);
});

test('no expression is expanded inside any run block', () => {
  const blocks = runBlocks(body);
  assert.ok(blocks.length >= 3);
  for (const { stepName, script } of blocks) {
    assert.ok(!script.includes('${{'), `step "${stepName}" expands an expression in run:`);
  }
});

test('every action is pinned to a full commit sha', () => {
  const uses = [...body.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 5);
  for (const u of uses) {
    assert.match(u, /@[0-9a-f]{40}$/, `unpinned action: ${u}`);
  }
});

test('the selector picks a changed package.json of a pnpm project consuming @branchleft', () => {
  const dir = fixture({
    'a/package.json': manifest({ '@branchleft/tsconfig': '^0.4.0' }),
    'b/package.json': manifest({ express: '^5.0.0' }),
    'c/package.json': manifest({
      '@branchleft/ghost-platform-render-core': 'link:../../render-core',
    }),
    'd/package.json': JSON.stringify({
      name: 'd',
      dependencies: { '@branchleft/tsconfig': '1.0.0' },
    }),
    'e/package.json': JSON.stringify({
      name: 'e',
      devDependencies: { '@branchleft/tsconfig': '1.0.0' },
    }),
    'e/pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'f/g/package.json': manifest({ '@branchleft/hetzner-host': '0.3.0' }),
    'package.json': manifest({}, { devDependencies: { '@branchleft/prettier-config': '^0.3.1' } }),
    'h/package.json': 'not json',
  });
  try {
    const got = select(dir, [
      'a/package.json',
      'b/package.json',
      'c/package.json',
      'd/package.json',
      'e/package.json',
      'f/g/package.json',
      'package.json',
      'h/package.json',
      'a/index.ts',
      'gone/package.json',
    ]);
    assert.equal(got.status, 0);
    assert.deepEqual(got.projects, [
      { dir: '.', slug: 'root' },
      { dir: 'a', slug: 'a' },
      { dir: 'e', slug: 'e' },
      { dir: 'f/g', slug: 'f-g' },
    ]);
    assert.deepEqual(select(dir, ['a/index.ts', 'README.md']).projects, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the selector skips a directory name outside the allow-list and refuses a flood', () => {
  const files = { 'ok/package.json': manifest({ '@branchleft/tsconfig': '1' }) };
  for (const odd of ['a b', 'a;id', '$(id)', '-rf', 'x"y']) {
    files[`${odd}/package.json`] = manifest({ '@branchleft/tsconfig': '1' });
  }
  const dir = fixture(files);
  try {
    const got = select(dir, Object.keys(files).concat(['../ok/package.json']));
    assert.deepEqual(got.projects, [{ dir: 'ok', slug: 'ok' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const many = {};
  for (let i = 0; i < 21; i++)
    many[`p${i}/package.json`] = manifest({ '@branchleft/tsconfig': '1' });
  const bigDir = fixture(many);
  try {
    assert.equal(select(bigDir, Object.keys(many)).status, 1);
  } finally {
    fs.rmSync(bigDir, { recursive: true, force: true });
  }
});

test('the selector picks the real infra/tenant project from this tree', () => {
  assert.deepEqual(select(ROOT, ['infra/tenant/package.json']).projects, [
    { dir: 'infra/tenant', slug: 'infra-tenant' },
  ]);
});

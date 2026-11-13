// A commit made in a linked worktree must not write into the shared hooks
// directory. Two things could do it, and each is pinned here:
//
// 1. The `prepare` script runs `pre-commit install`. In a linked worktree that
//    writes into the main clone's hooks directory, which every worktree shares.
//    It is run for real against a scratch repository with a stub `pre-commit`.
// 2. The prettier and eslint hooks call `pnpm run`, and pnpm installs first when
//    the tree has no node_modules, running `prepare` on the way. Both entries
//    must keep that install script-free. This part reads the config as text,
//    like the other config tests here, because the root tooling has no YAML
//    parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PREPARE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  .prepare;

function git(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  );
}

// Runs the real `prepare` script in `cwd` and says whether it reached the
// stub `pre-commit`. The stub only appends to a file; nothing is installed.
function installRan(cwd, stubDir, marker, extraEnv = {}) {
  fs.rmSync(marker, { force: true });
  const env = {
    ...process.env,
    ...extraEnv,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
  };
  if (!('CI' in extraEnv)) {
    delete env.CI;
  }
  execFileSync('sh', ['-c', PREPARE], { cwd, env, encoding: 'utf8' });
  return fs.existsSync(marker);
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-worktree-'));
  const main = path.join(dir, 'main');
  const linked = path.join(dir, 'linked');
  const stubDir = path.join(dir, 'bin');
  const marker = path.join(dir, 'pre-commit-ran');
  fs.mkdirSync(main);
  fs.mkdirSync(stubDir);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'seed');
  git(main, 'worktree', 'add', '-q', linked, '-b', 'linked');
  const stub = path.join(stubDir, 'pre-commit');
  fs.writeFileSync(stub, `#!/bin/sh\necho ran >> "${marker}"\n`);
  fs.chmodSync(stub, 0o755);
  return { dir, main, linked, stubDir, marker };
}

test('prepare installs the hook in the main clone', () => {
  const s = scratch();
  try {
    assert.equal(installRan(s.main, s.stubDir, s.marker), true);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('prepare does not install the hook from a linked worktree', () => {
  const s = scratch();
  try {
    assert.equal(installRan(s.linked, s.stubDir, s.marker), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('prepare installs nothing in CI', () => {
  const s = scratch();
  try {
    assert.equal(installRan(s.main, s.stubDir, s.marker, { CI: 'true' }), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

function hookEntry(id) {
  const text = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- id: ${id}`);
  assert.notEqual(start, -1, `hook ${id} is declared`);
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+entry:\s*(.*)$/.exec(line);
    if (m) {
      return m[1];
    }
    assert.ok(!/^\s*- id:/.test(line), `hook ${id} has an entry`);
  }
  return assert.fail(`hook ${id} has an entry`);
}

for (const [id, script] of [
  ['prettier', 'format'],
  ['eslint', 'lint'],
]) {
  test(`the ${id} hook keeps pnpm's pre-run install script-free`, () => {
    const entry = hookEntry(id);
    assert.match(entry, /pnpm_config_ignore_scripts=true\s+pnpm run /);
    assert.ok(entry.includes(`pnpm run ${script}`), `still runs the ${script} script`);
  });
}

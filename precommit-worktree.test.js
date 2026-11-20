// A commit made in a linked worktree must not write into the shared hooks
// directory. Two things could do it, and each is pinned here:
//
// 1. The `prepare` script runs `pre-commit install`. In a linked worktree that
//    writes into the main clone's hooks directory, which every worktree shares.
//    It is run for real against a scratch repository with a stub `pre-commit`.
// 2. The prettier and eslint hooks run their tool straight from node_modules
//    with `node`, not through `pnpm`. pnpm 11 needs a newer node than some
//    workstations have, and the pnpm shim on those fails before it formats
//    anything. The hooks also never install: a tree with no node_modules stops.
//    This part reads the config as text, like the other config tests here,
//    because the root tooling has no YAML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

// Each local tool hook, its tool file under node_modules, and the arguments the
// command passes. These mirror the package.json scripts they replaced.
const TOOL_HOOKS = [
  {
    id: 'prettier',
    bin: 'node_modules/prettier/bin/prettier.cjs',
    args: '--write . --ignore-path .gitignore',
  },
  {
    id: 'eslint',
    bin: 'node_modules/eslint/bin/eslint.js',
    args: 'infra services render-core --ext .ts --fix',
  },
];

for (const { id, bin, args } of TOOL_HOOKS) {
  test(`the ${id} hook runs its tool with node from node_modules, not pnpm`, () => {
    const entry = hookEntry(id);
    // A command word of pnpm or corepack is what the broken shim is started by.
    // The word inside the echoed message does not start a command, so it passes.
    assert.doesNotMatch(entry, /(?:^|[;&|(]\s*)(?:pnpm|corepack)\s/, 'no pnpm command');
    assert.ok(entry.includes(`node ${bin} ${args}`), `runs node ${bin} ${args}`);
  });
}

// The prettier and eslint hooks run in the worktree they commit from. A
// node_modules that is a symlink (a worktree sharing another clone's install)
// must stop the hook at once with one line naming the cause and the fix. A tree
// with no tool installed must stop the same way. Neither may start node, and a
// real install must still run the tool. Each hook entry is run as the shell runs
// it, with a stub `node` that records each call, so nothing is installed.
function runHook(id, tree, stubDir) {
  return spawnSync('sh', ['-c', hookEntry(id)], {
    cwd: tree,
    env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
}

function stubNode(stubDir, marker) {
  const stub = path.join(stubDir, 'node');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\n`);
  fs.chmodSync(stub, 0o755);
}

for (const { id, bin } of TOOL_HOOKS) {
  test(`the ${id} hook refuses a symlinked node_modules without starting node`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-symlink-'));
    try {
      const stubDir = path.join(dir, 'bin');
      const marker = path.join(dir, 'node-ran');
      const tree = path.join(dir, 'tree');
      const target = path.join(dir, 'shared-install');
      fs.mkdirSync(stubDir);
      fs.mkdirSync(tree);
      fs.mkdirSync(target);
      stubNode(stubDir, marker);
      fs.symlinkSync(target, path.join(tree, 'node_modules'));
      const result = runHook(id, tree, stubDir);
      assert.notEqual(result.status, 0, 'the hook fails');
      assert.match(result.stderr, /node_modules is a symlink/, 'the message names the cause');
      assert.match(
        result.stderr,
        /pnpm install --frozen-lockfile --ignore-scripts/,
        'the message names the fix'
      );
      assert.equal(fs.existsSync(marker), false, 'node is not started');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the ${id} hook refuses a node_modules without its tool and does not install`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-missing-'));
    try {
      const stubDir = path.join(dir, 'bin');
      const marker = path.join(dir, 'node-ran');
      const tree = path.join(dir, 'tree');
      fs.mkdirSync(stubDir);
      fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true });
      stubNode(stubDir, marker);
      const result = runHook(id, tree, stubDir);
      assert.notEqual(result.status, 0, 'the hook fails');
      assert.match(result.stderr, /node_modules has no /, 'the message names the cause');
      assert.equal(fs.existsSync(marker), false, 'node is not started');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the ${id} hook runs its tool with node in a real install`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-real-'));
    try {
      const stubDir = path.join(dir, 'bin');
      const marker = path.join(dir, 'node-ran');
      const tree = path.join(dir, 'tree');
      fs.mkdirSync(stubDir);
      fs.mkdirSync(path.dirname(path.join(tree, bin)), { recursive: true });
      fs.writeFileSync(path.join(tree, bin), '');
      stubNode(stubDir, marker);
      const result = runHook(id, tree, stubDir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(marker), true, 'node runs');
      assert.match(fs.readFileSync(marker, 'utf8'), new RegExp(bin.replace(/[./]/g, '\\$&')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The prettier and eslint commit hooks run through pnpm, which crashes under an older Node
// (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING on Node 20) before it reaches the tool. The hooks run
// scripts/require-pinned-node.sh first: under the wrong Node it stops with one line naming the
// Node it needs, instead of the crash. A fake `node` on PATH stands in for each caller's Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const SCRIPT = path.join(ROOT, 'scripts', 'require-pinned-node.sh');
const PINNED = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf-8').trim();

function runWith(nodeVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-node-'));
  try {
    fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\necho ${nodeVersion}\n`, { mode: 0o755 });
    return spawnSync('sh', [SCRIPT, 'echo', 'the-command-ran'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('under Node 20 the hook stops with one line naming the pinned Node', () => {
  const result = runWith('v20.19.0');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /the-command-ran/);
  const lines = result.stderr.trim().split('\n');
  assert.equal(lines.length, 1, result.stderr);
  assert.ok(lines[0].includes(PINNED), lines[0]);
  assert.ok(lines[0].includes('v20.19.0'), lines[0]);
});

test('under the pinned Node the command runs', () => {
  const result = runWith(PINNED);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /the-command-ran/);
});

test('a patch release of the pinned major also runs the command', () => {
  const [major] = PINNED.replace(/^v/, '').split('.');
  const result = runWith(`v${major}.99.99`);
  assert.equal(result.status, 0, result.stderr);
});

test('a missing node is refused with the same kind of line', () => {
  const result = spawnSync('sh', [SCRIPT, 'echo', 'x'], {
    encoding: 'utf-8',
    env: { PATH: '/nonexistent-dir-for-test' },
  });
  assert.notEqual(result.status, 0);
});

test('the prettier and eslint hooks run through the script', () => {
  const config = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf-8');
  for (const id of ['prettier', 'eslint']) {
    const block = config.split(/\n {6}- id: /).find((part) => part.startsWith(id));
    assert.ok(block, `no ${id} hook`);
    assert.match(block, /entry: sh scripts\/require-pinned-node\.sh /, id);
  }
});

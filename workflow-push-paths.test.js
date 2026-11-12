// A push to main starts a workflow on the same list of paths as its pull request.
//
// A pull request workflow that carries a `paths:` filter starts only when the
// diff touches something its job reads. If the same workflow ran unfiltered on
// every push to main, each merge would start the whole suite again for inputs
// that did not change: a hosted-runner slot, in an organisation that shares 20
// of them, for an analysis whose result cannot differ. So a filtered pull
// request implies a filtered push, and the per-package workflows that dropped
// the unfiltered push keep a weekly whole-tree run as the backstop for a file
// the list misses.
//
// Read as text with comments stripped, like the other workflow tests here,
// because the repo's Python jobs install no YAML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');

// The workflows whose push list equals their pull request list and which keep
// a scheduled whole-tree run. A new per-package CI workflow joins this list.
const BACKSTOPPED = [
  'broker-ci',
  'broker-systemd-boot-ci',
  'codeql',
  'demo-gate-ci',
  'demo-host-sudoers-ci',
  'drain-sidecar-ci',
  'export-bundler-ci',
  'identity-ci',
  'infra-hetzner-host-check-ci',
  'infra-provisioning-scripts-ci',
  'mail-collector-ci',
  'mailgun-shim-ci',
  'odask-ci',
  'render-core-ci',
  'request-guard-ci',
  'scanning-storage-ci',
  'sso-adapter-ci',
  'storage-gateway-ci',
].map((name) => `${name}.yml`);

export function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// Each trigger under the top-level `on:` mapping with its `paths:` list, or
// null for a trigger with no such list. Any other form of the trigger block
// throws, so a workflow written in a shape this test cannot read fails
// instead of being skipped.
export function triggers(text) {
  const lines = stripCommentLines(text).split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) {
    throw new Error('no top-level `on:` mapping');
  }
  const found = new Map();
  let trigger = null;
  let inPaths = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const key = line.match(/^ {2}([A-Za-z_]+):/);
    if (key) {
      trigger = key[1];
      inPaths = false;
      found.set(trigger, { paths: null, keys: new Set() });
      continue;
    }
    const child = line.match(/^ {4}([A-Za-z_-]+):/);
    if (child) {
      inPaths = child[1] === 'paths';
      found.get(trigger).keys.add(child[1]);
      if (inPaths) {
        found.get(trigger).paths = [];
      }
      continue;
    }
    const item = line.match(/^ {6}- +'?([^']*?)'?\s*$/);
    if (inPaths && item) {
      found.get(trigger).paths.push(item[1]);
    }
  }
  if (found.size === 0) {
    throw new Error('the `on:` mapping names no trigger');
  }
  return found;
}

export function problems(text, { backstopped = false } = {}) {
  const found = [];
  const on = triggers(text);
  const push = on.get('push')?.paths ?? null;
  const pull = on.get('pull_request')?.paths ?? null;
  const branchPush = on.has('push') && !on.get('push').keys.has('tags');
  if (pull && branchPush && push === null) {
    found.push('a filtered pull request needs a filtered push: the push list is missing');
  }
  if (backstopped) {
    if (!pull || !push) {
      found.push('a backstopped workflow filters both its pull request and its push');
    } else if (JSON.stringify(push) !== JSON.stringify(pull)) {
      found.push('the push list must equal the pull request list');
    }
    if (!on.has('schedule')) {
      found.push('a backstopped workflow keeps a scheduled whole-tree run');
    }
  }
  return found;
}

const files = fs
  .readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

test('there are workflows to check', () => {
  assert.ok(files.length > 0);
});

test('every backstopped workflow exists', () => {
  for (const name of BACKSTOPPED) {
    assert.ok(files.includes(name), name);
  }
});

for (const file of files) {
  test(`${file}: a filtered pull request has a filtered push`, () => {
    const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
    assert.deepEqual(problems(text, { backstopped: BACKSTOPPED.includes(file) }), []);
  });
}

const GOOD = [
  'name: x',
  'on:',
  '  push:',
  '    branches: [main]',
  '    paths:',
  "      - 'a/**'",
  "      - 'b.yml'",
  '  pull_request:',
  '    branches: [main]',
  '    paths:',
  "      - 'a/**'",
  "      - 'b.yml'",
  '  schedule:',
  "    - cron: '0 4 * * 1'",
  'jobs: {}',
  '',
].join('\n');

test('self-test: the good shape has no problem', () => {
  assert.deepEqual(problems(GOOD, { backstopped: true }), []);
});

test('self-test: an unfiltered push under a filtered pull request is refused', () => {
  const bad = GOOD.replace(
    "    paths:\n      - 'a/**'\n      - 'b.yml'\n  pull_request:",
    '  pull_request:'
  );
  assert.equal(problems(bad).length, 1);
});

test('self-test: a push list that differs from the pull request list is refused', () => {
  const bad = GOOD.replace("      - 'b.yml'\n  pull_request:", "      - 'c.yml'\n  pull_request:");
  assert.equal(problems(bad, { backstopped: true }).length, 1);
});

test('self-test: a backstopped workflow with no schedule is refused', () => {
  const bad = GOOD.replace("  schedule:\n    - cron: '0 4 * * 1'\n", '');
  assert.equal(problems(bad, { backstopped: true }).length, 1);
});

test('self-test: a workflow with no pull request filter needs no push filter', () => {
  const text =
    'name: x\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs: {}\n';
  assert.deepEqual(problems(text), []);
});

test('self-test: a trigger block the test cannot read throws', () => {
  assert.throws(() => problems('name: x\non: [push, pull_request]\njobs: {}\n'));
});

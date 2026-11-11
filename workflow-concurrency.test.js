// A pull request run is grouped per pull request and only those runs cancel.
//
// A superseded run of a PR workflow holds a hosted-runner slot: on the free
// plan the whole organisation shares 20 of them, so a stack of runs for old
// heads queues every other repository's work. The cure is a workflow-level
// concurrency group keyed on the pull request, cancelling only when the event
// is a pull_request. A push, merge_group, schedule or manual run falls back to
// its run id, so it is its own group and is never cancelled.
//
// Read as text with comments stripped, like the other workflow tests here,
// because the repo's Python jobs install no YAML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');
const GROUP = '${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}';
const CANCEL = "${{ github.event_name == 'pull_request' }}";
const BLOCK = `concurrency:\n  group: ${GROUP}\n  cancel-in-progress: ${CANCEL}\n`;
const PR_TRIGGERS = new Set(['pull_request', 'pull_request_target']);

export function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// The names under the top-level `on:` mapping. Any other form of the trigger
// block throws, so a workflow written in a shape this test cannot read fails
// instead of being skipped.
export function triggerNames(text) {
  const lines = stripCommentLines(text).split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) {
    throw new Error('no top-level `on:` mapping');
  }
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const key = line.match(/^ {2}([A-Za-z_]+):/);
    if (key) {
      names.push(key[1]);
    }
  }
  if (names.length === 0) {
    throw new Error('the `on:` mapping names no trigger');
  }
  return names;
}

export function problems(text) {
  const body = stripCommentLines(text);
  const found = [];
  const triggers = triggerNames(text);
  if (triggers.some((name) => PR_TRIGGERS.has(name)) && !body.includes(`\n${BLOCK}`)) {
    found.push('a pull request workflow must carry the exact top-level concurrency block');
  }
  for (const m of body.matchAll(/^[ \t]*cancel-in-progress:[ \t]*(.+?)[ \t]*$/gm)) {
    if (m[1] !== CANCEL && m[1] !== 'false') {
      found.push(`cancel-in-progress must be the pull_request expression or false, not ${m[1]}`);
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

for (const file of files) {
  test(`${file}: pull request runs are grouped per pull request and only those cancel`, () => {
    assert.deepEqual(problems(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8')), []);
  });
}

const GOOD = `name: x\non:\n  push:\n  pull_request:\n\n${BLOCK}\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;

test('self-test: the good shape has no problem', () => {
  assert.deepEqual(problems(GOOD), []);
});

test('self-test: a pull request workflow with no block is refused', () => {
  assert.equal(problems(GOOD.replace(BLOCK, '')).length, 1);
});

test('self-test: a group with no run id fallback is refused', () => {
  const bad = GOOD.replace(' || github.run_id', '');
  assert.equal(problems(bad).length, 1);
});

test('self-test: cancelling every event is refused', () => {
  const bad = GOOD.replace(CANCEL, 'true');
  assert.equal(problems(bad).length, 2);
});

test('self-test: a job level cancelling group is refused', () => {
  const bad = `${GOOD}    concurrency:\n      group: deploy\n      cancel-in-progress: true\n`;
  assert.equal(problems(bad).length, 1);
});

test('self-test: a workflow with no pull request trigger needs no block', () => {
  const text =
    'name: x\non:\n  schedule:\n    - cron: "1 2 * * *"\njobs:\n  a:\n    runs-on: ubuntu-latest\n';
  assert.deepEqual(problems(text), []);
});

test('self-test: a trigger block the test cannot read throws', () => {
  assert.throws(() => problems('name: x\non: [push, pull_request]\njobs: {}\n'));
});

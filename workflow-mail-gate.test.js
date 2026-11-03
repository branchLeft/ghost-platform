// The promotion path to GHCR runs through the mail gate. These checks pin what a
// careless edit would silently break: the push no longer waiting on the gate,
// the gate no longer running the candidate, or the gate gaining a push right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(import.meta.dirname, '.github', 'workflows', 'registry-push.yml');

function uncommented(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// A job block under `jobs:`: from its key to the next job key at the same indent.
function jobBlock(text, key) {
  const jobs = text.slice(text.search(/^jobs:\s*$/m));
  const start = jobs.search(new RegExp(`^  ${key}:\\s*$`, 'm'));
  assert.ok(start >= 0, `workflow has a ${key} job`);
  const next = jobs.slice(start + 1).search(/^  [a-z][a-z-]*:\s*$/m);
  return next < 0 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

const text = uncommented(fs.readFileSync(FILE, 'utf-8'));
const gate = jobBlock(text, 'mail-gate');
const push = jobBlock(text, 'push');

test('the push job needs the mail gate, so a failed gate refuses the push', () => {
  assert.match(push, /^    needs: mail-gate$/m);
});

test('the gate runs the mail gate script against the candidate it builds', () => {
  assert.match(gate, /docker build --tag ghost-platform:candidate/);
  assert.match(gate, /node scripts\/mail-gate\/mail-gate\.mjs ghost-platform:candidate/);
  assert.ok(
    gate.indexOf('docker build') < gate.indexOf('mail-gate.mjs'),
    'the candidate is built before the gate runs'
  );
});

test('the gate job is read-only: it pulls the spool and pushes nothing', () => {
  assert.doesNotMatch(gate, /packages: write/);
  assert.doesNotMatch(gate, /docker push/);
  assert.match(gate, /packages: read/);
});

test('the push job still pushes, and only after the gate has passed', () => {
  assert.match(push, /docker push "\$IMAGE" --all-tags/);
});

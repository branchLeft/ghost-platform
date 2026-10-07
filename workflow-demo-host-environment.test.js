// The demo-host apply job must run in its own environment, and its
// "ungated environment" check must read that same environment. If the two
// drift apart, the check passes on one environment while the job is held by
// another (or by none, which GitHub creates unprotected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');
const EXPECTED = 'production-demo-host';

function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

function environmentsDeclared(text) {
  return [...stripCommentLines(text).matchAll(/^[ \t]*environment:[ \t]*(\S+)/gm)].map((m) => m[1]);
}

function environmentsQueried(text) {
  return [...stripCommentLines(text).matchAll(/environments\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

test('the demo-host apply job declares its own environment', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'infra-demo-host-ci.yml'), 'utf8');
  assert.deepEqual(environmentsDeclared(text), [EXPECTED]);
});

test('the ungated-environment check reads the environment the job declares', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'infra-demo-host-ci.yml'), 'utf8');
  assert.deepEqual(environmentsQueried(text), [EXPECTED]);
});

test('the hosts stack keeps `production` and shares nothing with the demo host', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'infra-hosts-ci.yml'), 'utf8');
  assert.deepEqual(environmentsDeclared(text), ['production']);
  assert.deepEqual(environmentsQueried(text), ['production']);
});

test('the matchers see a drifted workflow', () => {
  const drifted = '    environment: production\n      gh api "repos/x/environments/production"\n';
  assert.deepEqual(environmentsDeclared(drifted), ['production']);
  assert.deepEqual(environmentsQueried(drifted), ['production']);
  const commented = '# environment: production\n';
  assert.deepEqual(environmentsDeclared(commented), []);
});

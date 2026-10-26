// Each apply job runs in its own environment (or the shared free one), and its
// "ungated environment" check must read the environment the job is in, or the
// check passes on one environment while another (or none) holds the job. The
// routing is replayed by infra/scripts/test_apply_environment_routing.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');
const FREE = 'production-free';

function stripCommentLines(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

function routed(owner) {
  return `\${{ needs.plan.outputs.apply_environment == '${FREE}' && '${FREE}' || '${owner}' }}`;
}

function environmentsDeclared(text) {
  return [...stripCommentLines(text).matchAll(/^[ \t]*environment:[ \t]*(.+?)[ \t]*$/gm)].map(
    (m) => m[1]
  );
}

function applyEnvironmentVariables(text) {
  return [...stripCommentLines(text).matchAll(/^[ \t]*APPLY_ENVIRONMENT:[ \t]*(.+?)[ \t]*$/gm)].map(
    (m) => m[1]
  );
}

function environmentsQueried(text) {
  return [
    ...stripCommentLines(text).matchAll(/environments\/(\$\{APPLY_ENVIRONMENT\}|[A-Za-z0-9_-]+)/g),
  ].map((m) => m[1]);
}

function allowedNames(text) {
  const gate = stripCommentLines(text).match(/case "\$\{APPLY_ENVIRONMENT\}" in\n\s*([^)]+)\) ;;/);
  return gate ? gate[1].split('|').map((n) => n.trim()) : [];
}

function read(file) {
  return fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
}

for (const [file, owner, label] of [
  ['infra-demo-host-ci.yml', 'production-demo-host', 'demo-host'],
  ['infra-hosts-ci.yml', 'production', 'hosts stack'],
]) {
  test(`the ${label} apply job declares its own environment or the free one, by the exact expression`, () => {
    assert.deepEqual(environmentsDeclared(read(file)), [routed(owner)]);
  });

  test(`the ${label} job's APPLY_ENVIRONMENT is the same expression`, () => {
    assert.deepEqual(applyEnvironmentVariables(read(file)), [routed(owner)]);
  });

  test(`the ${label} ungated-environment check reads the environment the job is in`, () => {
    // The plan job's readiness read of the free environment, then two reads
    // by the apply job, both of the environment it is in: the environment
    // itself and its deployment_protection_rules. Exactly three pins that
    // none is dropped.
    assert.deepEqual(environmentsQueried(read(file)), [
      FREE,
      '${APPLY_ENVIRONMENT}',
      '${APPLY_ENVIRONMENT}',
    ]);
  });

  test(`the ${label} ungated-environment check allows its own environment and the free one only`, () => {
    assert.deepEqual(allowedNames(read(file)), [owner, FREE]);
  });
}

test('the hosts stack and the demo host share only the free environment', () => {
  const hosts = stripCommentLines(read('infra-hosts-ci.yml'));
  const demo = stripCommentLines(read('infra-demo-host-ci.yml'));
  assert.ok(!hosts.includes('production-demo-host'));
  assert.ok(!/\|\| 'production' \}\}/.test(demo));
  assert.ok(!/\bproduction\)/.test(demo.replace(/production-demo-host\)/g, '')));
});

test('the matchers see a drifted workflow', () => {
  const drifted =
    '    environment: production\n      APPLY_ENVIRONMENT: production\n      gh api "repos/x/environments/production"\n';
  assert.deepEqual(environmentsDeclared(drifted), ['production']);
  assert.deepEqual(applyEnvironmentVariables(drifted), ['production']);
  assert.deepEqual(environmentsQueried(drifted), ['production']);
  const commented = '# environment: production\n';
  assert.deepEqual(environmentsDeclared(commented), []);
  const gate = 'case "${APPLY_ENVIRONMENT}" in\n  production | production-free) ;;\n';
  assert.deepEqual(allowedNames(gate), ['production', 'production-free']);
});

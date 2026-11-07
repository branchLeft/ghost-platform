// provision-tenant.yml asks the control plane whether the tenant name is taken,
// inside "Validate inputs": after the repo-register block, before any step that
// creates something, reading the credential from the environment only. These
// checks pin what a careless edit would silently break: the call moving after
// a mutating step, gaining an `|| true` or an `if:` that lets a refusal through,
// or reading the credential from somewhere the scoping guard does not cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(import.meta.dirname, '.github', 'workflows', 'provision-tenant.yml');
const text = fs.readFileSync(WORKFLOW, 'utf-8').replace(/^[ \t]*#.*$/gm, '');

const steps = text.split(/^(?= {6}- name: )/m).filter((s) => s.startsWith('      - name: '));
const stepIndex = (title) => steps.findIndex((s) => s.startsWith(`      - name: ${title}`));
const validateAt = stepIndex('Validate inputs');
const firstMutatingAt = stepIndex('Generate the tenant repo from the template');
const validate = steps[validateAt];

test('the workflow has the steps this test reasons about', () => {
  assert.ok(validateAt >= 0, 'Validate inputs exists');
  assert.ok(firstMutatingAt > validateAt, 'a repo-creating step follows Validate inputs');
});

test('the lookup runs inside Validate inputs, so before the first step that creates anything', () => {
  assert.match(
    validate,
    /^\s*node infra\/provisioning\/scripts\/tenant-name-lookup\.js \|\| exit 1\s*$/m
  );
  assert.equal(
    steps.filter((s) => s.includes('tenant-name-lookup.js')).length,
    1,
    'exactly one step calls it'
  );
});

test('the lookup comes after the repo-register block', () => {
  const registerAt = validate.indexOf('registers/tenant-names.json');
  const lookupAt = validate.indexOf('tenant-name-lookup.js');
  assert.ok(registerAt >= 0 && lookupAt > registerAt);
  const registerBlockEnd = validate.indexOf('\n          fi\n', registerAt);
  assert.ok(
    registerBlockEnd >= 0 && lookupAt > registerBlockEnd,
    'after the register block closes'
  );
});

test('the refusal cannot be bypassed in the step', () => {
  assert.doesNotMatch(validate, /^\s*(if|continue-on-error):/m);
  const call = validate.split('\n').find((line) => line.includes('tenant-name-lookup.js'));
  assert.doesNotMatch(call, /\|\|\s*true|;\s*true|2>\s*\/dev\/null|>\s*\/dev\/null/);
});

test('the credential and URL are read from the environment secret and repository variable', () => {
  assert.match(
    validate,
    /CONTROL_PLANE_NAME_LOOKUP_URL: \$\{\{ vars\.CONTROL_PLANE_NAME_LOOKUP_URL \}\}/
  );
  assert.match(
    validate,
    /CONTROL_PLANE_NAME_LOOKUP_TOKEN: \$\{\{ secrets\.CONTROL_PLANE_NAME_LOOKUP_TOKEN \}\}/
  );
  // Never on a command line, where it would be echoed into the log.
  assert.doesNotMatch(validate, /tenant-name-lookup\.js[^\n]*(TOKEN|\$\{\{)/);
});

test('the token is bound in this one step only, not job-wide', () => {
  const others = steps.filter((_, i) => i !== validateAt);
  for (const step of others) assert.ok(!step.includes('CONTROL_PLANE_NAME_LOOKUP_TOKEN'));
  const jobHeader = text.slice(0, text.indexOf('    steps:'));
  assert.ok(!jobHeader.includes('CONTROL_PLANE_NAME_LOOKUP_TOKEN'));
});

test('no step echoes or writes the lookup credential', () => {
  assert.doesNotMatch(text, /(echo|printf|tee|>>?)[^\n]*CONTROL_PLANE_NAME_LOOKUP_TOKEN/);
});

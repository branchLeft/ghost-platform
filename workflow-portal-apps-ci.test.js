// The portal applications workflow installs packages from GitHub Packages, so
// it holds a registry token. That token belongs to the install steps alone: a
// type check, build or test step runs code from the repository and from the
// packages just installed, and must not be able to read it. These checks pin
// where the token may appear, and prove the check itself can fail by running it
// on a copy that leaks the token to the whole job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = 'NODE_AUTH_TOKEN';
const WORKFLOW = path.join(import.meta.dirname, '.github', 'workflows', 'portal-apps-ci.yml');

function uncommented(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

// Everything before the job's `steps:` list is workflow or job scope; the list
// itself is split into one block per step.
function parts(text) {
  const at = text.search(/^ {4}steps:\s*$/m);
  assert.ok(at > -1, 'the job has a steps list');
  const scope = text.slice(0, at);
  const steps = text
    .slice(at)
    .split(/^ {6}- /m)
    .slice(1);
  assert.ok(steps.length > 0, 'the steps list has steps');
  return { scope, steps };
}

const nameOf = (step) => (step.match(/^name: (.*)$/m) ?? [])[1] ?? '(unnamed step)';
const installs = (step) => /\bpnpm install\b/.test(step);

// Every way the token could reach a step that is not an install step.
function leaks(text) {
  const { scope, steps } = parts(uncommented(text));
  const found = [];
  if (scope.includes(TOKEN)) found.push(`${TOKEN} is set at workflow or job level`);
  for (const step of steps) {
    if (!step.includes(TOKEN)) continue;
    if (!installs(step)) found.push(`${TOKEN} reaches "${nameOf(step)}", which installs nothing`);
    else if (/\bpnpm run\b/.test(step)) {
      found.push(`${TOKEN} reaches "${nameOf(step)}", which also runs a script`);
    }
  }
  for (const step of steps) {
    if (installs(step) && !step.includes(TOKEN)) {
      found.push(`"${nameOf(step)}" installs without the token and would fail to authenticate`);
    }
  }
  return found;
}

const real = fs.readFileSync(WORKFLOW, 'utf-8');

test('the registry token is on the install steps only', () => {
  assert.deepEqual(leaks(real), []);
});

test('no type check, build or test step can read the registry token', () => {
  const { steps } = parts(uncommented(real));
  const run = steps.filter((step) => /\bpnpm run (typecheck|build|coverage|test)/.test(step));
  assert.ok(run.length >= 5, `expected the build and test steps, found ${run.length}`);
  for (const step of run) {
    assert.ok(!step.includes(TOKEN), `${nameOf(step)} can read ${TOKEN}`);
  }
});

test('three installs carry the token: both built packages and the applications', () => {
  const { steps } = parts(uncommented(real));
  const withToken = steps.filter((step) => installs(step) && step.includes(TOKEN));
  assert.equal(withToken.length, 3);
});

test('the checkout does not keep its credential in the repository config', () => {
  const { steps } = parts(uncommented(real));
  const checkout = steps.find((step) => /^name: Checkout$/m.test(step));
  assert.ok(checkout, 'the job checks out the repository');
  assert.match(checkout, /^ {8}with:\n {10}persist-credentials: false$/m);
});

test('the workflow asks for no write scope', () => {
  const permissions = uncommented(real).match(/^permissions:\n((?:[ \t]+.*\n)+)/m);
  assert.ok(permissions, 'the workflow declares its permissions');
  assert.doesNotMatch(permissions[1], /: write\b/);
  assert.match(permissions[1], /packages: read/);
  assert.doesNotMatch(uncommented(real), /: write\b/);
});

test('the check can fail: a job-level token and a token on a test step are both caught', () => {
  const jobLevel = real.replace(
    /^( {4}env:\n)/m,
    `$1      ${TOKEN}: \${{ secrets.GITHUB_TOKEN }}\n`
  );
  assert.notEqual(jobLevel, real, 'the copy leaks the token to the job');
  assert.ok(leaks(jobLevel).some((line) => /job level/.test(line)));

  const onTest = real.replace(
    /( {8}run: pnpm run coverage\n)/,
    `$1        env:\n          ${TOKEN}: \${{ secrets.GITHUB_TOKEN }}\n`
  );
  assert.notEqual(onTest, real, 'the copy leaks the token to the test step');
  assert.ok(leaks(onTest).some((line) => /which installs nothing/.test(line)));

  const together = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: Install and build',
    '        run: pnpm install --frozen-lockfile && pnpm run build',
    '        env:',
    `          ${TOKEN}: x`,
    '',
  ].join('\n');
  assert.ok(leaks(together).some((line) => /also runs a script/.test(line)));
});

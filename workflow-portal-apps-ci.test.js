// The portal applications workflow installs packages from GitHub Packages, so
// it holds a registry token. That token belongs to the install steps alone: a
// type check, build or test step runs code from the repository and from the
// packages just installed, and must not be able to read it. These checks pin
// where the token may appear, and prove each check can fail by running it on a
// copy that breaks the rule.
//
// The workflow is parsed as YAML and the checks read the parsed jobs and steps,
// never the text: a re-indented file, a renamed step or a restructured job
// must not make a check quietly match nothing. Each check also refuses an
// empty answer (no jobs, no install steps, no checkout) rather than passing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';

const TOKEN = 'NODE_AUTH_TOKEN';
const WORKFLOW = path.join(import.meta.dirname, '.github', 'workflows', 'portal-apps-ci.yml');

const load = (text) => {
  const doc = parse(text);
  assert.ok(doc !== null && typeof doc === 'object', 'the workflow parses to a mapping');
  return doc;
};

// Every job and its steps. A job with no steps list (a reusable-workflow call,
// say) is refused rather than skipped: its steps would go unchecked.
function jobsOf(doc) {
  const entries = Object.entries(doc.jobs ?? {});
  assert.ok(entries.length > 0, 'the workflow has jobs');
  for (const [name, job] of entries) {
    assert.ok(
      Array.isArray(job.steps) && job.steps.length > 0,
      `job "${name}" has a steps list the checks can read`
    );
  }
  return entries;
}

function allSteps(doc) {
  return jobsOf(doc).flatMap(([job, { steps }]) => steps.map((step) => ({ job, step })));
}

const nameOf = (step) => step.name ?? step.uses ?? '(unnamed step)';
const mentions = (value) => JSON.stringify(value ?? null).includes(TOKEN);
const runOf = (step) => (typeof step.run === 'string' ? step.run : '');
const installs = (step) => /\bpnpm\s+(?:install|i|add)\b/.test(runOf(step));
const runsScript = (step) => /\bpnpm\s+(?:run|exec|dlx|test|start)\b/.test(runOf(step));

// Every way the token could reach a step that is not an install step.
function leaks(doc) {
  const found = [];
  const { jobs: _jobs, ...workflowScope } = doc;
  if (mentions(workflowScope)) found.push(`${TOKEN} is set at workflow level`);
  for (const [name, job] of jobsOf(doc)) {
    const { steps: _steps, ...jobScope } = job;
    if (mentions(jobScope)) found.push(`${TOKEN} is set at job level in "${name}"`);
  }
  for (const { step } of allSteps(doc)) {
    if (!mentions(step)) {
      if (installs(step)) {
        found.push(`"${nameOf(step)}" installs without the token and would fail to authenticate`);
      }
      continue;
    }
    if (!installs(step)) found.push(`${TOKEN} reaches "${nameOf(step)}", which installs nothing`);
    else if (runsScript(step)) {
      found.push(`${TOKEN} reaches "${nameOf(step)}", which also runs a script`);
    }
  }
  return found;
}

// Checkout steps found by what they use, not by their name, whose credential
// would stay in the repository config.
function checkoutsKeepingCredential(doc) {
  const checkouts = allSteps(doc).filter(({ step }) =>
    /^actions\/checkout(?:@|$)/.test(step.uses ?? '')
  );
  assert.ok(checkouts.length > 0, 'the workflow checks out the repository');
  return checkouts
    .filter(({ step }) => !(step.with?.['persist-credentials'] === false))
    .map(({ job, step }) => `"${nameOf(step)}" in "${job}"`);
}

// Every permissions block, at workflow and job level, as a list of grants.
function permissionGrants(doc) {
  const blocks = [doc.permissions, ...jobsOf(doc).map(([, job]) => job.permissions)];
  return blocks
    .filter((block) => block !== undefined)
    .flatMap((block) => (typeof block === 'string' ? [block] : Object.values(block)));
}

const realText = fs.readFileSync(WORKFLOW, 'utf-8');
const real = load(realText);
const copy = () => structuredClone(real);

test('the registry token is on the install steps only', () => {
  assert.deepEqual(leaks(real), []);
});

test('no type check, build or test step can read the registry token', () => {
  const run = allSteps(real).filter(({ step }) =>
    /\bpnpm\s+run\s+(typecheck|build|coverage|test)/.test(runOf(step))
  );
  assert.ok(run.length >= 5, `expected the build and test steps, found ${run.length}`);
  for (const { step } of run) {
    assert.ok(!mentions(step), `${nameOf(step)} can read ${TOKEN}`);
  }
});

test('five installs carry the token: the four built packages and the applications', () => {
  const steps = allSteps(real).filter(({ step }) => installs(step));
  assert.equal(steps.length, 5, 'the workflow has five install steps');
  assert.equal(steps.filter(({ step }) => mentions(step)).length, 5);
});

test('every checkout does not keep its credential in the repository config', () => {
  assert.deepEqual(checkoutsKeepingCredential(real), []);
});

test('the workflow asks for no write scope', () => {
  const grants = permissionGrants(real);
  assert.ok(grants.length > 0, 'the workflow declares its permissions');
  assert.deepEqual(
    grants.filter((grant) => /write/.test(grant)),
    []
  );
  assert.equal(real.permissions?.packages, 'read');
});

// The negative controls. Each copy breaks one rule, and the check that guards
// the rule has to say so; a check that stayed silent here would pass any file.

test('the token check can fail: a workflow-level, job-level or test-step token is caught', () => {
  const workflowLevel = copy();
  workflowLevel.env = { [TOKEN]: '${{ secrets.GITHUB_TOKEN }}' };
  assert.ok(leaks(workflowLevel).some((line) => /workflow level/.test(line)));

  const jobLevel = copy();
  const [firstJob] = Object.keys(jobLevel.jobs);
  jobLevel.jobs[firstJob].env[TOKEN] = '${{ secrets.GITHUB_TOKEN }}';
  assert.ok(leaks(jobLevel).some((line) => /job level/.test(line)));

  const onTest = copy();
  const coverage = allSteps(onTest).find(({ step }) => /\bpnpm run coverage\b/.test(runOf(step)));
  assert.ok(coverage, 'the copy has a test step to leak into');
  coverage.step.env = { [TOKEN]: '${{ secrets.GITHUB_TOKEN }}' };
  assert.ok(leaks(onTest).some((line) => /which installs nothing/.test(line)));

  const together = {
    jobs: {
      test: {
        steps: [
          {
            name: 'Install and build',
            run: 'pnpm install --frozen-lockfile && pnpm run build',
            env: { [TOKEN]: 'x' },
          },
        ],
      },
    },
  };
  assert.ok(leaks(together).some((line) => /also runs a script/.test(line)));

  const bare = copy();
  const install = allSteps(bare).find(({ step }) => installs(step));
  delete install.step.env;
  assert.ok(leaks(bare).some((line) => /installs without the token/.test(line)));
});

test('the token check survives a restructured workflow: re-indented, and still caught', () => {
  const reindented = load(stringify(real, { indent: 4 }));
  assert.deepEqual(leaks(reindented), []);
  assert.deepEqual(checkoutsKeepingCredential(reindented), []);

  const leaking = copy();
  const coverage = allSteps(leaking).find(({ step }) => /\bpnpm run coverage\b/.test(runOf(step)));
  coverage.step.env = { [TOKEN]: 'x' };
  assert.ok(leaks(load(stringify(leaking, { indent: 4 }))).length > 0);

  // A short form of the install command is still an install.
  const shortForm = copy();
  const first = allSteps(shortForm).find(({ step }) => installs(step));
  first.step.run = 'pnpm i --frozen-lockfile';
  assert.deepEqual(leaks(shortForm), []);
  first.step.run = 'pnpm i --frozen-lockfile && pnpm test';
  assert.ok(leaks(shortForm).some((line) => /also runs a script/.test(line)));
});

test('the checkout check can fail: a dropped, true or renamed persist-credentials is caught', () => {
  const dropped = copy();
  const checkout = allSteps(dropped).find(({ step }) => /^actions\/checkout@/.test(step.uses));
  assert.ok(checkout, 'the copy has a checkout step');
  delete checkout.step.with['persist-credentials'];
  assert.equal(checkoutsKeepingCredential(dropped).length, 1);

  const set = copy();
  allSteps(set).find(({ step }) => /^actions\/checkout@/.test(step.uses)).step.with[
    'persist-credentials'
  ] = true;
  assert.equal(checkoutsKeepingCredential(set).length, 1);

  const noWith = copy();
  delete allSteps(noWith).find(({ step }) => /^actions\/checkout@/.test(step.uses)).step.with;
  assert.equal(checkoutsKeepingCredential(noWith).length, 1);

  // The checkout is found by the action it uses, so a step renamed away from
  // "Checkout" is still held to the rule.
  const renamed = copy();
  const step = allSteps(renamed).find(({ step: s }) => /^actions\/checkout@/.test(s.uses)).step;
  step.name = 'Fetch the sources';
  delete step.with;
  assert.deepEqual(checkoutsKeepingCredential(renamed), ['"Fetch the sources" in "test"']);

  // A workflow with no checkout at all is refused, not passed.
  const none = copy();
  none.jobs.test.steps = none.jobs.test.steps.filter((s) => !/^actions\/checkout@/.test(s.uses));
  assert.throws(() => checkoutsKeepingCredential(none), /checks out the repository/);
});

test('the write-scope check can fail: a write grant at either level is caught', () => {
  const workflowWrite = copy();
  workflowWrite.permissions['id-token'] = 'write';
  assert.ok(permissionGrants(workflowWrite).some((grant) => /write/.test(grant)));

  const jobWrite = copy();
  jobWrite.jobs.test.permissions = 'write-all';
  assert.ok(permissionGrants(jobWrite).some((grant) => /write/.test(grant)));
});

test('a workflow the checks cannot read is refused, not passed', () => {
  assert.throws(() => jobsOf({}), /has jobs/);
  assert.throws(() => jobsOf({ jobs: { call: { uses: './.github/workflows/x.yml' } } }), /steps/);
});

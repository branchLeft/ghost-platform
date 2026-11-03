// The promotion path to GHCR runs through the mail gate. These checks pin what a
// careless edit would silently break: the gate no longer running on the exact
// image that is pushed, the gate or the push gaining an `if:` or a
// `continue-on-error` that lets a failed gate through, and the gate's own CI
// job no longer running its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');

function uncommented(file) {
  return fs.readFileSync(path.join(WORKFLOWS, file), 'utf-8').replace(/^[ \t]*#.*$/gm, '');
}

// A job block under `jobs:`: from its key to the next job key at the same indent.
function jobBlock(text, key) {
  const jobs = text.slice(text.search(/^jobs:\s*$/m));
  const start = jobs.search(new RegExp(`^  ${key}:\\s*$`, 'm'));
  assert.ok(start >= 0, `workflow has a ${key} job`);
  const next = jobs.slice(start + 1).search(/^  [a-z][a-z-]*:\s*$/m);
  return next < 0 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

// A job's steps, each from its `- name:` line to the next one.
function stepsOf(job) {
  return job.split(/^(?=      - name: )/m).filter((s) => s.startsWith('      - name: '));
}

const BYPASS = /^\s*(if|continue-on-error):/m;

const text = uncommented('registry-push.yml');
const push = jobBlock(text, 'push');
const steps = stepsOf(push);
const stepIndex = (re) => steps.findIndex((s) => re.test(s));
const gateAt = stepIndex(/mail-gate\.mjs/);
const pushAt = stepIndex(/docker push/);
const buildAt = stepIndex(/docker build(?!x)/);

test('there is no separate gate job: the gate runs inside the push job', () => {
  assert.doesNotMatch(text, /^  mail-gate:\s*$/m);
  assert.doesNotMatch(push, /^    needs:/m);
  assert.ok(gateAt >= 0, 'the push job has a mail gate step');
});

test('the gate runs on the exact image that is built, then pushed', () => {
  assert.match(steps[gateAt], /node scripts\/mail-gate\/mail-gate\.mjs "\$IMAGE:\$IMAGE_TAG"/);
  assert.match(steps[buildAt], /--tag "\$IMAGE:\$IMAGE_TAG"/);
  assert.match(steps[pushAt], /docker push "\$IMAGE" --all-tags/);
  assert.ok(buildAt >= 0 && buildAt < gateAt, 'the image is built before the gate runs');
  assert.ok(gateAt < pushAt, 'the gate runs before the push');
  assert.equal(
    steps.filter((s) => /docker build(?!x)/.test(s)).length,
    1,
    'one build only, so the gated image is the pushed image'
  );
});

test('neither the gate step nor the push step can be skipped or waved through', () => {
  assert.doesNotMatch(steps[gateAt], BYPASS, 'the gate step has no if: or continue-on-error');
  assert.doesNotMatch(steps[pushAt], BYPASS, 'the push step has no if: or continue-on-error');
});

test('the push job and the workflow carry no bypass; the only if: is the summary step', () => {
  assert.doesNotMatch(text, /continue-on-error/, 'no continue-on-error anywhere');
  const jobHead = push.slice(0, push.indexOf('\n    steps:'));
  assert.doesNotMatch(jobHead, BYPASS, 'the job itself has no if:');
  const ifs = steps.filter((s) => /^\s*if:/m.test(s));
  assert.equal(ifs.length, 1, 'exactly one step carries an if:');
  assert.match(ifs[0], /^      - name: Write outcome to job summary$/m);
  assert.match(ifs[0], /^        if: always\(\)$/m);
});

test('the push job keeps the one packages: write grant, job-level', () => {
  assert.match(push, /^      packages: write$/m);
  assert.match(push, /docker\/login-action@/);
});

test('the gate has its own PR job: it builds both images and runs the gate test', () => {
  const ci = uncommented('mail-gate-ci.yml');
  assert.match(ci, /^  pull_request:$/m);
  for (const p of ['scripts/mail-gate/**', '.github/workflows/registry-push.yml']) {
    assert.ok(ci.includes(`- '${p}'`), `the PR job is path-triggered on ${p}`);
  }
  assert.match(ci, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(ci, /secrets\.|packages: write|login-action/);
  assert.match(ci, /docker build --tag ghost-platform:ci \./);
  assert.match(ci, /docker build --tag spool-standin:ci scripts\/mail-gate\/spool-standin/);
  assert.match(ci, /node --test scripts\/mail-gate\/mail-gate\.test\.mjs/);
  assert.match(ci, /MAIL_GATE_SPOOL_IMAGE: spool-standin:ci/);
  assert.doesNotMatch(ci, BYPASS, 'the gate CI job cannot be skipped or waved through');
});

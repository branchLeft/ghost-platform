// The mysql image is third-party, so its signature says "this workflow pulled
// this digest, scanned it and vouched for it". These checks pin the properties
// that keep that honest: the identity is a literal equal to the file's own
// path, the signing grants sit on the one job, the order is pull, scan, attest
// (nothing is signed before the scan step has passed), the attest step is the
// shared composite action and not a copy, and no step swallows a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const FILE = '.github/workflows/mysql-image-attest.yml';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8');
const uncommented = (file) => read(file).replace(/^[ \t]*#.*$/gm, '');
const text = uncommented(FILE);

// The steps of the job, each from its `- name:` line to the next step.
const steps = text.split(/\n(?=      - name: )/).filter((s) => s.includes('- name: '));
const stepAt = (prefix) =>
  steps.findIndex((s) => s.includes(`- name: ${prefix}`) || s.includes(`- name: '${prefix}`));
const stepNamed = (prefix) => {
  const at = stepAt(prefix);
  assert.ok(at > -1, `a step named ${prefix}`);
  return steps[at];
};

test('the expected identity is a literal equal to this file path, never read from the run', () => {
  const values = [...text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(values, [`branchLeft/ghost-platform/${FILE}`]);
  assert.doesNotMatch(text, /workflow_ref|job_workflow_ref/);
  assert.match(text, /repo: branchLeft\/ghost-platform\n/);
});

test('the signing grants are on the one job and nowhere above it', () => {
  for (const grant of ['id-token: write', 'attestations: write', 'packages: write']) {
    assert.equal(text.split(grant).length - 1, 1, `${grant} appears exactly once`);
  }
  const beforeJobs = text.slice(0, text.indexOf('\njobs:'));
  assert.doesNotMatch(beforeJobs, /id-token|attestations|packages/);
  assert.match(text, /\n {4}if: github\.ref == 'refs\/heads\/main'\n/);
});

test('the order is resolve, pull, scan, attest, then the summary', () => {
  const resolve = stepAt('Resolve the pinned image');
  const pull = stepAt('Step 1 of 4');
  const scan = stepAt('Step 2 of 4');
  const attest = stepAt('Steps 3 and 4 of 4');
  const summary = stepAt('Write outcome to job summary');
  assert.ok(resolve > -1 && pull > resolve && scan > pull && attest > scan && summary > attest);
});

test('the scan step fails closed and the attest step has no condition to skip it', () => {
  const scan = stepNamed('Step 2 of 4');
  assert.match(scan, /\n {10}exit 1\s*$/);
  assert.doesNotMatch(scan, /\n {8}if: /);
  assert.doesNotMatch(text, /continue-on-error|\|\| true/);
  assert.doesNotMatch(stepNamed('Steps 3 and 4 of 4'), /\n {8}if: /);
});

test('attest and verify is the shared composite action, with no inline copy', () => {
  const attest = stepNamed('Steps 3 and 4 of 4');
  assert.match(attest, /uses: \.\/\.github\/actions\/attest-and-verify-image\n/);
  assert.match(attest, /image: \$\{\{ steps\.pin\.outputs\.image \}\}/);
  assert.match(attest, /digest: \$\{\{ steps\.pin\.outputs\.digest \}\}/);
  assert.doesNotMatch(
    text,
    /attest-build-provenance|attestation verify|verify-image-attestation\.sh"/
  );
});

test('the digest comes from the mirror list through the resolver, and is pulled by digest', () => {
  const resolve = stepNamed('Resolve the pinned image');
  assert.match(
    resolve,
    /python3 scripts\/resolve-mirror-entry\.py "\$MIRROR_NAME" "\$UPSTREAM_TAG" >> "\$GITHUB_OUTPUT"/
  );
  const pull = stepNamed('Step 1 of 4');
  assert.match(pull, /docker pull "\$IMAGE@\$DIGEST"/);
  assert.match(pull, /grep -Fxq "\$IMAGE@\$DIGEST"/);
  assert.doesNotMatch(text, /sha256:[0-9a-f]{64}/, 'no digest literal: the list is the one home');
});

test('a change to the list or the resolver re-runs the workflow', () => {
  for (const f of [FILE, '.github/image-mirror/images.json', 'scripts/resolve-mirror-entry.py']) {
    assert.ok(text.includes(`      - ${f}\n`), `${f} is in the path filter`);
  }
  assert.doesNotMatch(text, /pull_request/, 'a pull request never reaches the signing grants');
});

test('no run block takes an expression, and every action is a local one or pinned to a sha', () => {
  for (const s of steps) {
    const at = s.indexOf('run:');
    if (at > -1) assert.doesNotMatch(s.slice(at), /\$\{\{/, 'no expression in a run block');
  }
  const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S.*)$/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const line of uses) {
    if (line.startsWith('./.github/actions/')) continue;
    assert.match(line, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `pinned: ${line}`);
  }
});

test('the CI workflow watches this workflow and runs this test', () => {
  const ci = read('.github/workflows/image-attestation-ci.yml');
  for (const f of [FILE, 'workflow-mysql-image-attest.test.js']) {
    assert.equal(ci.split(`- ${f}\n`).length - 1, 2, `${f} is in both path filters`);
  }
  assert.ok(
    uncommented('.github/workflows/image-attestation-ci.yml').includes(
      'node --test workflow-mysql-image-attest.test.js'
    )
  );
});

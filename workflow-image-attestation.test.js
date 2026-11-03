// The image publish workflows sign what they push, and the check that says
// the signature is genuine is only worth anything if it names the right
// identity. These checks pin the properties that keep it honest: each workflow
// passes a literal identity equal to its own file path (never one read from the
// run it is checking), the signing permissions sit on the publishing job only,
// the attestation is made and then verified and then tried with a wrong
// identity, the verify script forwards the identity flags, and every action
// used is pinned to a full commit sha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8');
const uncommented = (file) => read(file).replace(/^[ \t]*#.*$/gm, '');

const REPO = 'branchLeft/ghost-platform';
const ACTION = '.github/actions/attest-and-verify-image/action.yml';
const VERIFY = 'scripts/verify-image-attestation.sh';
const IMAGE_WORKFLOWS = ['registry-push.yml', 'portal-apps-image.yml'];

// The text of one job: from its `  name:` line to the next job or the end.
// Searched after `jobs:` because a trigger can share a job's name (`push:`).
function jobBlock(text, name) {
  const jobsAt = text.indexOf('\njobs:');
  assert.ok(jobsAt > -1, 'workflow has a jobs section');
  const jobs = text.slice(jobsAt + 1);
  const start = jobs.search(new RegExp(`^  ${name}:\\n`, 'm'));
  assert.ok(start > -1, `workflow has a ${name} job`);
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\n/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

for (const name of IMAGE_WORKFLOWS) {
  const file = `.github/workflows/${name}`;
  const text = uncommented(file);
  const push = jobBlock(text, 'push');

  test(`${name}: the expected identity is a literal equal to this file's own path`, () => {
    const values = [...text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(values, [`${REPO}/${file}`]);
    assert.doesNotMatch(
      text,
      /workflow_ref|job_workflow_ref/,
      'no identity read from the run itself'
    );
    assert.doesNotMatch(
      text.match(/signer-workflow:.*/)[0],
      /\$\{\{/,
      'the identity is not an expression'
    );
  });

  test(`${name}: signing permissions are on the push job only`, () => {
    for (const grant of ['id-token: write', 'attestations: write']) {
      assert.equal(text.split(grant).length - 1, 1, `${grant} appears exactly once`);
      assert.ok(push.includes(grant), `${grant} is in the push job`);
    }
    const beforeJobs = text.slice(0, text.indexOf('\njobs:'));
    assert.doesNotMatch(beforeJobs, /id-token|attestations/);
  });

  test(`${name}: the digest is read back, then attested and verified, before the summary`, () => {
    const read_ = push.indexOf('id: digest');
    const attest = push.indexOf('uses: ./.github/actions/attest-and-verify-image');
    const summary = push.indexOf('Write outcome to job summary');
    assert.ok(read_ > -1 && attest > -1 && summary > -1);
    assert.ok(read_ < attest, 'the digest is read before it is attested');
    assert.ok(attest < summary, 'attest and verify runs before the summary');
    assert.match(push, /digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/);
    assert.match(push, /image: \$\{\{ env\.IMAGE \}\}/);
    assert.match(push, /repo: branchLeft\/ghost-platform\n/);
  });
}

const action = uncommented(ACTION);
const apiAt = action.indexOf('Verify the attestation through the GitHub API');
const ociAt = action.indexOf('Verify the attestation from the registry');
const sabotageAt = action.indexOf('Prove a wrong identity is rejected');

test('the action attests the digest with the registry copy stored and nothing else granted', () => {
  assert.match(action, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.match(action, /subject-name: \$\{\{ inputs\.image \}\}/);
  assert.match(action, /subject-digest: \$\{\{ inputs\.digest \}\}/);
  assert.match(action, /push-to-registry: true/);
  assert.match(action, /create-storage-record: false/);
  assert.doesNotMatch(action, /artifact-metadata/);
});

test('the action verifies twice with the real identity, then requires a wrong one to be refused', () => {
  const attest = action.indexOf('actions/attest-build-provenance@');
  assert.ok(attest > -1 && apiAt > attest && ociAt > apiAt && sabotageAt > ociAt);
  const sabotageStep = action.slice(sabotageAt);
  assert.match(
    sabotageStep,
    /"\$GITHUB_WORKSPACE\/scripts\/prove-wrong-identity-rejected\.sh" "\$IMAGE@\$DIGEST" "\$REPO" "\$SIGNER_WORKFLOW"/,
    'the wrong-identity check is the script, called with the real identity'
  );
  assert.doesNotMatch(sabotageStep, /\.sabotage/, 'the wrong identity is built in the script');
  assert.doesNotMatch(action, /\|\| true|continue-on-error/, 'no failure is swallowed');
});

test('each real-identity verify retries five times, with waits totalling about two minutes', () => {
  const apiStep = action.slice(apiAt, ociAt);
  const ociStep = action.slice(ociAt, sabotageAt);
  for (const step of [apiStep, ociStep]) {
    assert.match(step, /for attempt in 1 2 3 4 5; do/, 'five attempts');
    assert.match(
      step,
      /pause=\$\(\(attempt \* 12\)\)/,
      'the wait grows each attempt: 12, 24, 36, 48 seconds'
    );
    assert.match(step, /VERIFY_PLAIN_ERRORS="\$plain"/, 'earlier attempts are plain text');
    assert.match(step, /echo "Verify .*attempt \$attempt of 5"/, 'each attempt is logged');
    assert.match(step, /::error::[^\n]*in 5 attempts"\n {8}exit 1/, 'the last failure is red');
  }
  assert.match(ociStep, /--bundle-from-oci/);
});

test('the wrong-identity script refuses by identity through both paths and never by a fault', () => {
  const script = read('scripts/prove-wrong-identity-rejected.sh');
  assert.match(script, /WRONG="\$3\.sabotage"/, 'the wrong identity is the signer with .sabotage');
  assert.match(script, /VERIFY_PLAIN_ERRORS=1/, 'the expected refusal is plain text');
  assert.match(
    script,
    /"\$VERIFY" "\$IMAGE_REF" "\$REPO" "\$WRONG" \$2/,
    'the second path adds --bundle-from-oci'
  );
  assert.match(script, /--bundle-from-oci/);
  assert.match(
    script,
    /no matching CertificateIdentity\|Subject Alternative Name\|Policy verification failed/
  );
  assert.match(script, /accepted \$1: the verify check is vacuous/, 'an acceptance fails the job');
});

test('the action reads inputs through env, never into the script text', () => {
  const runBlocks = [...action.matchAll(/run: \|\n((?: {8}.*\n?)+)/g)].map((m) => m[1]);
  assert.ok(runBlocks.length >= 4);
  for (const block of runBlocks) {
    assert.doesNotMatch(block, /\$\{\{/, 'no expression inside a run script');
  }
});

test('the verify script fixes every identity flag and refuses a non-digest reference', () => {
  const script = read(VERIFY);
  for (const flag of [
    '--repo "$REPO"',
    '--signer-workflow "$SIGNER_WORKFLOW"',
    '--source-ref refs/heads/main',
    '--cert-oidc-issuer https://token.actions.githubusercontent.com',
    '--deny-self-hosted-runners',
  ]) {
    assert.ok(script.includes(flag), `the script passes ${flag}`);
  }
  assert.ok(script.includes('@sha256:[0-9a-f]{64}$'), 'the script requires a digest reference');
});

test('every action used is a local one or pinned to a full commit sha', () => {
  const files = [
    ACTION,
    '.github/workflows/image-attestation-ci.yml',
    ...IMAGE_WORKFLOWS.map((n) => `.github/workflows/${n}`),
  ];
  for (const file of files) {
    const uses = [...uncommented(file).matchAll(/^\s*(?:- )?uses: (\S.*)$/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, `${file} uses an action`);
    for (const line of uses) {
      if (line.startsWith('./.github/actions/')) continue;
      assert.match(
        line,
        /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        `${file} pinned: ${line}`
      );
    }
  }
});

test('the CI workflow is read-only', () => {
  const text = uncommented('.github/workflows/image-attestation-ci.yml');
  assert.match(text, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(text, /write|id-token|attestations|secrets\./);
});

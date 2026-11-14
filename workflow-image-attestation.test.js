// The image publish workflows sign what they push, and the check that says
// the signature is genuine is only worth anything if it names the right
// identity. These checks pin the properties that keep it honest: each workflow
// passes a literal identity equal to its own file path (never one read from the
// run it is checking), the signing permissions sit on the attest job only, the
// attest job reads the pushed digest and calls the shared attest-and-verify
// action (whose own tests live with it in branchLeft/github-workflows), the
// verify script forwards the identity flags, and every action used is pinned to
// a full commit sha. The scan that gates the attest is in
// workflow-image-scan-before-attest.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8');
const uncommented = (file) => read(file).replace(/^[ \t]*#.*$/gm, '');

const REPO = 'branchLeft/ghost-platform';
const VERIFY = 'scripts/verify-image-attestation.sh';
const IMAGE_WORKFLOWS = [
  'registry-push.yml',
  'portal-apps-image.yml',
  'demo-edge-image.yml',
  'demo-gate-image.yml',
  'mail-collector-image.yml',
  'drain-sidecar-image.yml',
  'recovery-image.yml',
  'percona-image.yml',
];

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
  const attestJob = jobBlock(text, 'attest');

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

  test(`${name}: signing permissions are on the attest job only`, () => {
    for (const grant of ['id-token: write', 'attestations: write']) {
      assert.equal(text.split(grant).length - 1, 1, `${grant} appears exactly once`);
      assert.ok(attestJob.includes(grant), `${grant} is in the attest job`);
      assert.ok(!push.includes(grant), `${grant} is not in the push job`);
    }
    const beforeJobs = text.slice(0, text.indexOf('\njobs:'));
    assert.doesNotMatch(beforeJobs, /id-token|attestations/);
  });

  test(`${name}: the digest is read back in the push job and attested in the attest job`, () => {
    assert.ok(push.includes('id: digest'), 'the push job reads the digest back');
    assert.match(push, /digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/);
    assert.match(
      attestJob,
      /uses: branchLeft\/github-workflows\/\.github\/actions\/attest-and-verify-image@/
    );
    assert.match(attestJob, /digest: \$\{\{ needs\.push\.outputs\.digest \}\}/);
    assert.match(attestJob, /image: \$\{\{ env\.IMAGE \}\}/);
    assert.match(attestJob, /repo: branchLeft\/ghost-platform\n/);
    assert.match(attestJob, /needs: \[push, scan\]/, 'the attest waits on the scan');
  });
}

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

test('every action used is pinned to a full commit sha', () => {
  const files = [
    '.github/workflows/image-attestation-ci.yml',
    '.github/workflows/image-attestation-tokenless.yml',
    ...IMAGE_WORKFLOWS.map((n) => `.github/workflows/${n}`),
  ];
  for (const file of files) {
    const uses = [...uncommented(file).matchAll(/^\s*(?:- )?uses: (\S.*)$/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, `${file} uses an action`);
    for (const line of uses) {
      assert.match(
        line,
        /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
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

// The token-less probe workflow and its scripts. The probe must run the one
// verifier, under the host's scrubbed keys, and no token may reach its step.
const TOKENLESS = '.github/workflows/image-attestation-tokenless.yml';
const PROBE = 'scripts/probe-tokenless-attestation.sh';
const RESOLVE = 'scripts/resolve-published-image.sh';
const PROBE_TEST = 'scripts/test-probe-tokenless-attestation.sh';

// The steps of a job, each from its `- name:` line to the next step.
function steps(text) {
  return text.split(/\n(?=      - name: )/).filter((s) => s.includes('- name: '));
}

function stepNamed(text, prefix) {
  const found = steps(text).find((s) => s.includes(`- name: ${prefix}`));
  assert.ok(found, `a step named ${prefix}`);
  return found;
}

test('the token-less workflow grants read only and never swallows a failure', () => {
  const text = uncommented(TOKENLESS);
  assert.match(text, /permissions:\n {2}contents: read\n/);
  assert.match(text, /permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.doesNotMatch(text, /id-token|attestations|packages/);
  assert.doesNotMatch(text, /continue-on-error|\|\| true/);
});

test('github.token reaches only the two resolve steps, and the probe step has no token', () => {
  const text = uncommented(TOKENLESS);
  const withToken = steps(text).filter((s) => s.includes('github.token'));
  assert.equal(withToken.length, 2, 'github.token is in exactly two steps');
  for (const s of withToken) {
    assert.match(s, /- name: Resolve /, 'github.token is only in a resolve step');
  }
  const probe = stepNamed(text, 'Probe the verifier with a placeholder GH_TOKEN');
  assert.doesNotMatch(probe, /GH_TOKEN:|GITHUB_TOKEN|github\.token|secrets\./);
  assert.doesNotMatch(text, /secrets\./, 'no secret in the workflow');
});

test('the job has one probe step, standing: no step is red by design, none is conditional', () => {
  const text = uncommented(TOKENLESS);
  const probes = steps(text).filter((s) => s.includes('probe-tokenless-attestation.sh'));
  assert.equal(probes.length, 1, 'one probe step');
  assert.doesNotMatch(text, /\n {8}if: /, 'no step condition');
  assert.doesNotMatch(text, /PROBE_GH_TOKEN_PLACEHOLDER|Experiment/, 'no experiment left');
});

test('the probe runs after both resolve steps and is given both references', () => {
  const text = uncommented(TOKENLESS);
  const real = text.indexOf('- name: Resolve the real');
  const control = text.indexOf('- name: Resolve the control');
  const probeAt = text.indexOf('- name: Probe the verifier with a placeholder GH_TOKEN');
  assert.ok(real > -1 && control > -1 && probeAt > real && probeAt > control);
  const probe = stepNamed(text, 'Probe the verifier with a placeholder GH_TOKEN');
  assert.match(
    probe,
    /run: \.\/scripts\/probe-tokenless-attestation\.sh "\$REAL_IMAGE" "\$CONTROL_IMAGE"\s*$/
  );
  assert.match(probe, /REAL_IMAGE: \$\{\{ steps\.real\.outputs\.image \}\}/);
  assert.match(probe, /CONTROL_IMAGE: \$\{\{ steps\.control\.outputs\.image \}\}/);
});

test('no run block takes an expression, and no workflow or probe text runs the verifier directly', () => {
  const text = uncommented(TOKENLESS);
  for (const s of steps(text)) {
    const at = s.indexOf('run:');
    if (at > -1) assert.doesNotMatch(s.slice(at), /\$\{\{/, 'no expression in a run block');
  }
  for (const file of [TOKENLESS, PROBE, RESOLVE]) {
    assert.doesNotMatch(
      uncommented(file),
      /attestation verify/,
      `${file} has no second copy of the verifier`
    );
  }
});

test('the probe calls the one verifier with the literal identity, under the host keys', () => {
  const probe = read(PROBE);
  assert.match(probe, /VERIFY="\$HERE\/verify-image-attestation\.sh"/);
  assert.match(
    probe,
    /SIGNER="branchLeft\/ghost-platform\/\.github\/workflows\/registry-push\.yml"/
  );
  assert.match(probe, /scrubbed "\$VERIFY" "\$1" "\$REPO" "\$SIGNER" --bundle-from-oci/);
  for (const key of [
    'PATH=',
    'HOME="$EMPTY"',
    'GH_CONFIG_DIR="$EMPTY"',
    'XDG_CONFIG_HOME="$EMPTY"',
    'GH_PROMPT_DISABLED=1',
    'GH_NO_UPDATE_NOTIFIER=1',
    'LC_ALL=C',
    'VERIFY_PLAIN_ERRORS=1',
  ]) {
    assert.ok(probe.includes(key), `the scrubbed environment sets ${key}`);
  }
  assert.doesNotMatch(
    probe,
    /GH_TOKEN=(?!"\$PLACEHOLDER")|GITHUB_TOKEN=|\|\| true/,
    'no token is set but the one literal placeholder, nothing is swallowed'
  );
  assert.match(
    probe,
    /\nPLACEHOLDER="placeholder-not-a-credential"\n/,
    'the placeholder is one fixed literal, not read from the environment'
  );
  assert.doesNotMatch(probe, /\$\{PROBE_GH_TOKEN|\$\{GH_TOKEN/, 'no caller token is read');
  for (const flag of ['--source-ref refs/heads/main', '--deny-self-hosted-runners']) {
    assert.ok(
      read('scripts/verify-image-attestation.sh').includes(flag),
      `the one verifier keeps ${flag}`
    );
  }
  assert.doesNotMatch(probe, /with no token|TOKENLESS VERIFY OK|auth status/);
  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
  ]) {
    assert.ok(probe.includes(name), `the environment proof checks ${name}`);
  }
});

test('the CI workflow lists the new files in both path filters and runs the probe test', () => {
  const ci = read('.github/workflows/image-attestation-ci.yml');
  for (const f of [PROBE, RESOLVE, PROBE_TEST, TOKENLESS]) {
    assert.equal(ci.split(`- ${f}\n`).length - 1, 2, `${f} is in both path filters`);
  }
  assert.ok(
    uncommented('.github/workflows/image-attestation-ci.yml').includes(`run: ./${PROBE_TEST}`)
  );
});

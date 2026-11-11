// The promote-candidate workflow signs a verdict onto an image digest, so the
// properties that keep that honest are pinned here as text, like the other
// workflow tests: the signing grants and the registry write sit on the one job
// that signs, that job installs nothing, the identity it is verified against is
// a literal naming this file (never the registry push's), no step that matters
// can be skipped, no input reaches a shell except through env, and every action
// is pinned to a full commit sha. The behaviour of the scripts it runs is in
// promote/promote.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const FILE = '.github/workflows/promote-candidate.yml';
const text = fs.readFileSync(path.join(ROOT, FILE), 'utf-8').replace(/^[ \t]*#.*$/gm, '');

// The text of one job: from its `  name:` line to the next job or the end.
function jobBlock(name) {
  const jobs = text.slice(text.indexOf('\njobs:') + 1);
  const start = jobs.search(new RegExp(`^  ${name}:\\n`, 'm'));
  assert.ok(start > -1, `workflow has a ${name} job`);
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\n/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

const attest = jobBlock('attest');
const decide = jobBlock('decide');
const gates = jobBlock('gates');

test('it is dispatched by hand only and holds no permission at the top', () => {
  const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
  assert.deepEqual(
    [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]),
    ['workflow_dispatch']
  );
  assert.match(text, /\npermissions: \{\}\n/);
});

test('only main may run it', () => {
  assert.match(gates, /GITHUB_REF" != "refs\/heads\/main"/);
});

test('the signing grants and the registry write are on the attest job and nowhere else', () => {
  for (const grant of ['id-token: write', 'attestations: write', 'packages: write']) {
    assert.equal(text.split(grant).length - 1, 1, `${grant} appears exactly once`);
    assert.ok(attest.includes(grant), `${grant} is in the attest job`);
  }
  assert.doesNotMatch(gates + decide, /: write/, 'gates and decide hold no write grant');
});

test('the attest job installs nothing and the workflow pushes no image', () => {
  assert.doesNotMatch(attest, /pnpm|npm |yarn|pip |setup-python|action-setup/);
  assert.doesNotMatch(text, /docker push|docker buildx build[^\n]*--push|docker tag/);
  assert.doesNotMatch(text, /packages: write[\s\S]*docker push/);
});

test('the identity the signature is verified against is a literal naming this file', () => {
  const values = [...text.matchAll(/--signer-workflow (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(values, [`branchLeft/ghost-platform/${FILE}`]);
  assert.doesNotMatch(text, /workflow_ref|job_workflow_ref/);
  assert.doesNotMatch(text, /registry-push\.yml/, 'not the identity that pushes the image');
  assert.match(text, /--repo branchLeft\/ghost-platform\b/);
});

test('the predicate type signed is the one the scripts name', async () => {
  const { PREDICATE_TYPE } = await import('./promote/shape.mjs');
  const signed = [...text.matchAll(/predicate-type: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(signed, [PREDICATE_TYPE]);
});

test('the check on the predicate runs before the attestation and the verify after it', () => {
  const at = (needle) => attest.indexOf(needle);
  assert.ok(at('promote/check-predicate.mjs') > -1);
  assert.ok(at('promote/check-predicate.mjs') < at('uses: actions/attest@'));
  assert.ok(at('uses: actions/attest@') < at('promote/verify-promotion.mjs'));
  assert.match(attest, /push-to-registry: true/);
});

test('no condition or continue-on-error can skip or soften a step', () => {
  assert.doesNotMatch(text, /continue-on-error/);
  assert.doesNotMatch(text, /^\s+if:/m);
});

test('the jobs run in order: gates, then decide, then attest', () => {
  assert.match(decide, /needs: gates/);
  assert.match(attest, /needs: decide/);
});

test('a pipe to the summary runs under pipefail', () => {
  for (const block of text.split(/\n(?= {6}- name:)/)) {
    if (/\| tee /.test(block)) assert.match(block, /shell: bash/, 'a tee needs shell: bash');
  }
});

test('no input expression sits inside a shell script; inputs arrive through env', () => {
  const lines = text.split('\n');
  let inRun = false;
  let indent = 0;
  for (const line of lines) {
    const open = line.match(/^(\s*)run: [|>]-?\s*$/);
    if (open) {
      inRun = true;
      indent = open[1].length;
      continue;
    }
    if (inRun && line.trim() !== '' && line.search(/\S/) <= indent) inRun = false;
    if (inRun) assert.doesNotMatch(line, /\$\{\{/, `an expression inside a run: ${line.trim()}`);
  }
  for (const line of lines.filter((l) => /^\s*run: [^|>]/.test(l))) {
    assert.doesNotMatch(line, /\$\{\{/, `an expression inside a run: ${line.trim()}`);
  }
});

test('every action is pinned to a full commit sha', () => {
  const uses = [...text.matchAll(/^\s*uses: (\S+)(?: #.*)?$/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned to a sha`);
});

test('checkouts do not keep credentials', () => {
  for (const block of text.split(/\n(?= {6}- name:)/)) {
    if (/uses: actions\/checkout@/.test(block)) assert.match(block, /persist-credentials: false/);
  }
});

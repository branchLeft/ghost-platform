// The workflow is where the proof meets real images, and a mistake there is
// silent: a pair that drifted from the Dockerfile's pin, an expected exit code
// that no longer matches the CLI, or a step that swallows the verdict.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './cli.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const workflow = read('.github', 'workflows', 'rollback-proof-ci.yml');
const code = workflow.replace(/^[ \t]*#.*$/gm, '');
const dockerfile = read('Dockerfile');
const mirror = JSON.parse(read('.github', 'image-mirror', 'images.json'));

const GHOST_REF = /ghost:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}/g;
const matrix = [
  ...code.matchAll(/- case: (\w+)\n\s+old: (\S+)\n\s+new: (\S+)\n\s+expect: '(\d)'/g),
].map((m) => ({ name: m[1], old: m[2], new: m[3], expect: m[4] }));

describe('the live matrix', () => {
  it('has the accepted case and the refused case, each with the exit code the CLI gives', () => {
    assert.deepEqual(
      matrix.map((m) => [m.name, m.expect]),
      [
        ['accepted', String(EXIT.accepted)],
        ['refused', String(EXIT.refused)],
      ]
    );
  });

  it('runs the old image the Dockerfile pins today', () => {
    const pinned = dockerfile.match(/^FROM (ghost:\S+-alpine@sha256:[0-9a-f]{64})$/m)?.[1];
    assert.ok(pinned, 'the Dockerfile pins a ghost image by digest');
    assert.ok(
      matrix.every((m) => m.old === pinned),
      `old image is ${pinned}`
    );
  });

  it('accepts the image on its own data and refuses a real later release', () => {
    const [accepted, refused] = matrix;
    assert.equal(accepted.old, accepted.new);
    assert.notEqual(refused.old, refused.new);
  });

  it('uses digests the image mirror list also records, so the pair is a known pair', () => {
    const digests = new Set(mirror.images.map((i) => i.digest));
    for (const ref of matrix.flatMap((m) => [m.old, m.new])) {
      assert.ok(digests.has(ref.split('@')[1]), `${ref} is on the mirror list`);
    }
  });

  it('names no Ghost image outside the matrix', () => {
    const inMatrix = new Set(matrix.flatMap((m) => [m.old, m.new]));
    for (const ref of code.match(GHOST_REF) ?? []) assert.ok(inMatrix.has(ref), ref);
  });
});

describe('the job steps', () => {
  it('does not swallow the verdict: the exit code is compared, not discarded', () => {
    assert.match(code, /rc=0\n\s+node rollback-proof\/cli\.mjs run [^\n]*\|\| rc=\$\?/);
    assert.match(code, /test "\$rc" = "\$EXPECT"/);
    assert.doesNotMatch(code, /continue-on-error/);
  });

  it('checks the refusal names the renamed column', () => {
    assert.match(code, /jq -e [^\n]*"missing-column"[^\n]*"email_batches"[^\n]*"provider_id"/);
  });

  it('the candidate job fails on any non-zero exit and verifies the record', () => {
    const candidate = code.slice(code.indexOf('  candidate:'));
    assert.match(candidate, /run: node rollback-proof\/cli\.mjs run /);
    assert.match(candidate, /run: node rollback-proof\/cli\.mjs verify /);
    assert.doesNotMatch(candidate, /\|\| (true|rc=)/);
  });

  it("runs the upstream images on the stock profile and the candidate on the caller's", () => {
    assert.match(code, /cli\.mjs run --profile stock --old "\$OLD_IMAGE"/);
    assert.match(code, /PROFILE: \$\{\{ inputs\.profile \}\}/);
    assert.match(code, /cli\.mjs run --profile "\$PROFILE"/);
    assert.match(code, /profile:\n\s+description:[^\n]*\n\s+required: false\n\s+default: platform/);
  });

  it('takes both images from the caller, by input', () => {
    assert.match(code, /workflow_call:\n\s+inputs:\n\s+old-image:[\s\S]*?new-image:/);
    assert.match(code, /OLD_IMAGE: \$\{\{ inputs\.old-image \}\}/);
    assert.match(code, /NEW_IMAGE: \$\{\{ inputs\.new-image \}\}/);
  });

  it('reads exactly one mysql pin from the db runbook, and it exists', () => {
    const pins = new Set(read('db', 'RUNBOOK-db.md').match(/mysql:8\.0@sha256:[0-9a-f]{64}/g));
    assert.equal(pins.size, 1);
    assert.match(code, /grep -oE 'mysql:8\\\.0@sha256:\[0-9a-f\]\{64\}' db\/RUNBOOK-db\.md/);
  });
});

describe('what the workflow may do', () => {
  it('reads the repo and writes nothing, with no secret', () => {
    assert.match(code, /permissions:\n {2}contents: read\n/);
    assert.doesNotMatch(code, /: write/);
    assert.doesNotMatch(code, /secrets\./);
    assert.doesNotMatch(code, /docker login|docker\/login-action/);
  });

  it('pins every action by commit', () => {
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  });

  it('runs the live jobs only after the unit tests, and never on a call', () => {
    assert.match(code, /live:[\s\S]*?needs: proof/);
    assert.equal(
      (code.match(/if: \$\{\{ github\.event_name != 'workflow_call' \}\}/g) ?? []).length,
      2
    );
  });
});

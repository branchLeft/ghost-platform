// Every workflow that pushes an image to ghcr.io/branchleft scans the pushed
// digest with the shared image-scan workflow, and only then calls the shared
// attest-and-verify action, so an image that fails the scan is never signed.
// Both come from branchLeft/github-workflows at one pinned release; this
// repository carries no copy of either. Each case below breaks one property in
// a copy of the real text and requires a named problem, so a passing run means
// the check can see the break. Read as text, like the other workflow tests
// here, because the repo's Python jobs install no YAML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseJobs } from './test-support/publish-job-checks.mjs';

const ROOT = import.meta.dirname;
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const REPO = 'branchLeft/ghost-platform';

// The commit the signed tag v1.1.0 of branchLeft/github-workflows points at.
const PIN = '77506b6d4603ef432bbdec734139fec91e5bea47';
const SCAN_USES = `branchLeft/github-workflows/.github/workflows/image-scan.yml@${PIN} # v1.1.0`;
const ATTEST_USES = `branchLeft/github-workflows/.github/actions/attest-and-verify-image@${PIN} # v1.1.0`;

// workflow file -> the image it pushes.
const PUBLISHERS = {
  'registry-push.yml': 'ghcr.io/branchleft/ghost-tenant',
  'portal-apps-image.yml': 'ghcr.io/branchleft/portal-apps',
  'demo-edge-image.yml': 'ghcr.io/branchleft/demo-edge',
  'mail-collector-image.yml': 'ghcr.io/branchleft/mail-collector',
  'drain-sidecar-image.yml': 'ghcr.io/branchleft/drain-sidecar',
  'recovery-image.yml': 'ghcr.io/branchleft/db-recovery',
};

// Workflows that push but are not covered here, and why. A workflow that pushes
// and is in neither list fails the discovery test below.
const NOT_COVERED = {
  'image-mirror.yml': 'copies third-party images by digest; the mirror has its own change',
  'mailgun-shim-image.yml': 'its attest step comes from an open change; the scan joins it there',
};

// The shapes of a step that sends an image to a registry.
const PUSHES =
  /docker push|build-push-action|docker buildx build[^\n]*--push|imagetools create|skopeo copy|crane (?:copy|push|cp)\b/;

const read = (file) => fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
// Whole-line comments go, so text inside a comment can never satisfy a check.
// Trailing comments stay: the `# v1.1.0` beside a pin is part of what is checked.
const uncommented = (text) => text.replace(/^[ \t]*#.*$/gm, '');

function permissionsOf(jobText) {
  const block = /^ {4}permissions:\n((?: {6}\S.*\n?)+)/m.exec(jobText);
  if (!block) return null;
  return Object.fromEntries(
    block[1]
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/:\s*/))
  );
}

function needsOf(jobText) {
  const m = /^ {4}needs:\s*(.+)$/m.exec(jobText);
  if (!m) return [];
  return m[1]
    .replace(/[[\]]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function withKeys(jobText) {
  const block = /^ {4}with:\n((?: {6}\S.*\n?)+)/m.exec(jobText);
  if (!block) return {};
  return Object.fromEntries(
    block[1]
      .trim()
      .split('\n')
      .map((l) => {
        const at = l.indexOf(':');
        return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
      })
  );
}

export function problems(source, { file, image }) {
  const found = [];
  const text = uncommented(source);
  const jobs = parseJobs(text, false);
  const { push, scan, attest } = jobs;
  if (!push) return ['there is no push job'];
  if (!scan) return ['there is no scan job'];
  if (!attest) return ['there is no attest job'];

  const top = text.split(/^jobs:\n/m)[0];
  if (/:\s*write(-all)?\s*$|^\s*permissions:\s*write-all/m.test(top)) {
    found.push('top-level permissions grant a write scope');
  }

  // The digest the scan and the attest read is the one read back after the push.
  if (!/image: \$\{\{ steps\.digest\.outputs\.image \}\}/.test(push.text)) {
    found.push('push job does not output the pushed reference');
  }
  if (!/digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/.test(push.text)) {
    found.push('push job does not output the pushed digest');
  }
  if (
    !/echo "image=\$IMAGE@\$digest"/.test(push.text) ||
    !/docker inspect[^\n]*RepoDigests/.test(push.text)
  ) {
    found.push('the pushed reference is not image@digest read back from the image store');
  }
  if (/id-token|attestations:/.test(push.text)) {
    found.push('push job holds a signing grant; only attest may');
  }

  // The scan: the shared workflow, at the pinned release, on the digest, and
  // nothing that could soften it.
  if (!/^ {4}needs: push\s*$/m.test(scan.text)) found.push('scan job does not wait on push');
  const scanUses = /^ {4}uses: (.+)$/m.exec(scan.text);
  if (!scanUses || scanUses[1].trim() !== SCAN_USES) {
    found.push('scan job does not call image-scan.yml at the pinned v1.1.0');
  }
  const scanWith = withKeys(scan.text);
  if (scanWith.image !== '${{ needs.push.outputs.image }}') {
    found.push('scan job does not scan the pushed digest reference');
  }
  if (Object.keys(scanWith).some((k) => k !== 'image')) {
    found.push('scan job passes an input other than the image');
  }
  const scanPermissions = permissionsOf(scan.text);
  if (JSON.stringify(scanPermissions) !== JSON.stringify({ contents: 'read', packages: 'read' })) {
    found.push('scan job permissions are not exactly contents: read, packages: read');
  }
  for (const [name, job] of [
    ['scan', scan],
    ['attest', attest],
  ]) {
    if (/continue-on-error|\|\| true/.test(job.text)) {
      found.push(`${name} job swallows a failure`);
    }
    if (/^ {4}if:/m.test(job.text)) found.push(`${name} job can be skipped by a condition`);
  }

  // The attest: after the scan, from the shared action, on the digest.
  const needs = needsOf(attest.text);
  if (!needs.includes('scan') || !needs.includes('push')) {
    found.push('attest job does not wait on both push and scan');
  }
  const attestUses = [...attest.text.matchAll(/^\s*uses: (\S.*)$/gm)].map((m) => m[1].trim());
  if (!attestUses.includes(ATTEST_USES)) {
    found.push('attest job does not call attest-and-verify-image at the pinned v1.1.0');
  }
  if (!/^ {10}digest: \$\{\{ needs\.push\.outputs\.digest \}\}$/m.test(attest.text)) {
    found.push('attest job does not attest the pushed digest');
  }
  if (!attest.text.split('\n').includes(`      IMAGE: ${image}`)) {
    found.push(`attest job does not name ${image}`);
  }
  if (!/^ {10}image: \$\{\{ env\.IMAGE \}\}$/m.test(attest.text)) {
    found.push('attest job does not pass the image name');
  }
  const signers = [...attest.text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]);
  if (signers.length !== 1 || signers[0] !== `${REPO}/.github/workflows/${file}`) {
    found.push('signer-workflow is not the literal path of this workflow');
  }
  if (!new RegExp(`^ {10}repo: ${REPO}$`, 'm').test(attest.text)) {
    found.push('attest job does not name the repository literally');
  }
  const attestPermissions = permissionsOf(attest.text);
  const wanted = {
    contents: 'read',
    packages: 'write',
    'id-token': 'write',
    attestations: 'write',
  };
  if (JSON.stringify(attestPermissions) !== JSON.stringify(wanted)) {
    found.push('attest job permissions are not exactly the four the action needs');
  }

  // No second copy of the attest or the verify in this workflow.
  if (
    /attest-build-provenance|attestation verify|prove-wrong-identity|\.\/\.github\/actions\//.test(
      text
    )
  ) {
    found.push('the workflow carries its own copy of the attest or verify step');
  }

  // Every reference to the shared repository is the one pin.
  for (const m of text.matchAll(/uses: (branchLeft\/github-workflows\/\S+)(.*)$/gm)) {
    if (`${m[1]}${m[2]}` !== `${m[1]} # v1.1.0` || !m[1].endsWith(`@${PIN}`)) {
      found.push(`github-workflows reference is not pinned to v1.1.0: ${m[0]}`);
    }
  }
  return found;
}

const hasProblem = (list, expected) => list.some((p) => p.includes(expected));

// Replace text that must be there: a mutation that silently changed nothing
// would let its case pass without proving anything.
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

for (const [file, image] of Object.entries(PUBLISHERS)) {
  const real = read(file);

  test(`${file}: pushes, scans the pushed digest, then attests it from the shared action`, () => {
    assert.deepEqual(problems(real, { file, image }), []);
  });

  test(`${file}: the checker reports each way the scan-before-attest order can break`, () => {
    const scanJob = /\n {2}scan:\n[\s\S]*?(?=\n {2}attest:\n)/.exec(real);
    assert.ok(scanJob, 'the real text has a scan job before the attest job');
    const cases = [
      // The scan is removed, or no longer gates the attest.
      [real.replace(scanJob[0], ''), 'there is no scan job'],
      [swap(real, '    needs: [push, scan]\n', '    needs: push\n'), 'wait on both push and scan'],
      [
        swap(real, '    needs: [push, scan]\n', '    needs: [scan]\n'),
        'wait on both push and scan',
      ],
      [
        swap(real, '    needs: [push, scan]\n', '    needs: [push, scan]\n    if: always()\n'),
        'skipped by a condition',
      ],
      [
        swap(
          real,
          '    needs: push\n    permissions:\n      contents: read\n      packages: read\n    uses:',
          '    permissions:\n      contents: read\n      packages: read\n    uses:'
        ),
        'scan job does not wait on push',
      ],
      // The scan runs on something other than the pushed digest.
      [
        swap(real, 'image: ${{ needs.push.outputs.image }}', `image: ${image}:latest`),
        'does not scan the pushed digest',
      ],
      [
        swap(real, 'digest: ${{ needs.push.outputs.digest }}', `digest: ${image}:latest`),
        'does not attest the pushed digest',
      ],
      [
        swap(real, 'echo "image=$IMAGE@$digest"', 'echo "image=$IMAGE:$IMAGE_TAG"'),
        'image@digest read back',
      ],
      // The scan is softened.
      [
        swap(
          real,
          '    with:\n      image: ${{ needs.push.outputs.image }}',
          '    with:\n      image: ${{ needs.push.outputs.image }}\n      allow-empty-sbom: true'
        ),
        'input other than the image',
      ],
      [
        swap(
          real,
          '    with:\n      image: ${{ needs.push.outputs.image }}',
          '    with:\n      image: ${{ needs.push.outputs.image }}\n      exemptions-path: .image-scan-exemptions.json'
        ),
        'input other than the image',
      ],
      [swap(real, `image-scan.yml@${PIN} # v1.1.0`, `image-scan.yml@${PIN}`), 'pinned to v1.1.0'],
      [swap(real, `image-scan.yml@${PIN} # v1.1.0`, 'image-scan.yml@v1.0.6'), 'pinned to v1.1.0'],
      [
        swap(real, `attest-and-verify-image@${PIN} # v1.1.0`, 'attest-and-verify-image@main'),
        'pinned to v1.1.0',
      ],
      // A copy of the attest comes back, or the signing grant moves.
      [
        swap(
          real,
          `        uses: ${ATTEST_USES}\n`,
          '        uses: ./.github/actions/attest-and-verify-image\n'
        ),
        'carries its own copy',
      ],
      [
        swap(
          real,
          `        uses: ${ATTEST_USES}\n`,
          '        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2\n'
        ),
        'carries its own copy',
      ],
      [
        swap(
          real,
          '    permissions:\n      contents: read\n      packages: write\n      id-token: write\n',
          '    permissions:\n      contents: read\n      packages: write\n'
        ),
        'four the action needs',
      ],
      [
        swap(
          real,
          '      attestations: write\n',
          '      attestations: write\n      actions: write\n'
        ),
        'four the action needs',
      ],
      [
        swap(
          real,
          `signer-workflow: ${REPO}/.github/workflows/${file}`,
          'signer-workflow: ${{ github.workflow_ref }}'
        ),
        'signer-workflow is not the literal',
      ],
    ];
    for (const [text, expected] of cases) {
      const found = problems(text, { file, image });
      assert.ok(
        hasProblem(found, expected),
        `expected "${expected}", got ${JSON.stringify(found)}`
      );
    }
  });
}

test('a signing grant on the push job is reported', () => {
  const file = 'registry-push.yml';
  const real = read(file);
  const widened = swap(
    real,
    '    permissions:\n      contents: read\n      packages: write\n\n    outputs:',
    '    permissions:\n      contents: read\n      packages: write\n      id-token: write\n\n    outputs:'
  );
  assert.ok(hasProblem(problems(widened, { file, image: PUBLISHERS[file] }), 'only attest may'));
});

test('every workflow that pushes an image is covered here or named with a reason', () => {
  const pushers = fs
    .readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .filter((f) => PUSHES.test(uncommented(read(f))));
  for (const file of pushers) {
    assert.ok(
      file in PUBLISHERS || file in NOT_COVERED,
      `${file} pushes an image but is neither scanned before attest here nor named with a reason`
    );
  }
  for (const file of Object.keys(PUBLISHERS)) {
    assert.ok(pushers.includes(file), `${file} is listed as a publisher but pushes nothing`);
  }
  for (const file of Object.keys(NOT_COVERED)) {
    assert.ok(fs.existsSync(path.join(WORKFLOWS, file)), `${file} is listed but does not exist`);
  }
});

test('the build-only image workflows push nothing, so they need no scan', () => {
  for (const file of ['demo-gate-image.yml', 'odask-image.yml']) {
    const text = uncommented(read(file));
    assert.doesNotMatch(text, PUSHES, `${file} pushes an image`);
    assert.doesNotMatch(text, /packages:\s*write|id-token/, `${file} holds a publish credential`);
  }
});

test('artifact attestation is signed only through the shared action, bar the broker release', () => {
  for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    if (file === 'broker-release.yml') continue;
    assert.doesNotMatch(
      uncommented(read(file)),
      /uses: actions\/attest-build-provenance@/,
      `${file} signs without the shared action`
    );
  }
});

test('the local copy of the attest action is gone', () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, '.github', 'actions', 'attest-and-verify-image')),
    false
  );
});

test('every workflow calls the scan at one revision, as the scan workflow requires', () => {
  const refs = new Set();
  for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    for (const m of read(file).matchAll(
      /uses:\s*['"]?branchLeft\/github-workflows\/\.github\/workflows\/image-scan\.yml@([^\s"'#]+)/g
    )) {
      refs.add(m[1]);
    }
  }
  assert.deepEqual([...refs], [PIN]);
});

test('no exemption file exists, so no workflow wires one', () => {
  assert.equal(fs.existsSync(path.join(ROOT, '.image-scan-exemptions.json')), false);
  for (const file of Object.keys(PUBLISHERS)) {
    assert.doesNotMatch(read(file), /exemptions-path/);
  }
});

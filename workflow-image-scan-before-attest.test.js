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
import { swap } from './test-support/workflow-text.ts';

const ROOT = import.meta.dirname;
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const REPO = 'branchLeft/ghost-platform';

// The commit the signed tag v1.2.7 of branchLeft/github-workflows points at.
const PIN = 'f559ca696956d3d58440f56666d85f36c829c08b';
const SCAN_USES = `branchLeft/github-workflows/.github/workflows/image-scan.yml@${PIN} # v1.2.7`;
const ATTEST_USES = `branchLeft/github-workflows/.github/actions/attest-and-verify-image@${PIN} # v1.2.7`;

// workflow file -> the image it pushes.
const PUBLISHERS = {
  'registry-push.yml': 'ghcr.io/branchleft/ghost-tenant',
  'portal-apps-image.yml': 'ghcr.io/branchleft/portal-apps',
  'demo-edge-image.yml': 'ghcr.io/branchleft/demo-edge',
  'demo-gate-image.yml': 'ghcr.io/branchleft/demo-gate',
  'mail-collector-image.yml': 'ghcr.io/branchleft/mail-collector',
  'drain-sidecar-image.yml': 'ghcr.io/branchleft/drain-sidecar',
  'recovery-image.yml': 'ghcr.io/branchleft/db-recovery',
  'storage-gateway-image.yml': 'ghcr.io/branchleft/priv/storage-gateway',
  'percona-image.yml': 'ghcr.io/branchleft/percona-server',
  'mysqld-exporter-image.yml': 'ghcr.io/branchleft/mysqld-exporter',
  'mailgun-shim-image.yml': 'ghcr.io/branchleft/mailgun-shim',
  // A workflow that publishes two images from one push job lists both, in the
  // order of PAIR_SUFFIXES. Each has its own scan and attest job (see pairProblems).
  'activitypub-image.yml': [
    'ghcr.io/branchleft/activitypub',
    'ghcr.io/branchleft/activitypub-migrate',
  ],
};

// Workflows that push but are not covered here, and why. A workflow that pushes
// and is in neither list fails the discovery test below.
const NOT_COVERED = {
  'image-mirror.yml': 'copies third-party images by digest; the mirror has its own change',
};

// The shapes of a step that sends an image to a registry.
const PUSHES =
  /docker push|build-push-action|docker buildx build[^\n]*--push|imagetools create|skopeo copy|crane (?:copy|push|cp)\b/;

const read = (file) => fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
// Whole-line comments go, so text inside a comment can never satisfy a check.
// Trailing comments stay: the `# v1.2.7` beside a pin is part of what is checked.
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
    found.push('scan job does not call image-scan.yml at the pinned v1.2.7');
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
    found.push('attest job does not call attest-and-verify-image at the pinned v1.2.7');
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

  found.push(...sharedPinProblems(text));
  return found;
}

// Every reference to the shared repository is the one pin. Shared by the
// single-image and the two-image checkers.
function sharedPinProblems(text) {
  const found = [];
  for (const m of text.matchAll(/uses: (branchLeft\/github-workflows\/\S+)(.*)$/gm)) {
    if (`${m[1]}${m[2]}` !== `${m[1]} # v1.2.7` || !m[1].endsWith(`@${PIN}`)) {
      found.push(`github-workflows reference is not pinned to v1.2.7: ${m[0]}`);
    }
  }
  return found;
}

// A two-image workflow: one push job publishes both images, and each image has
// its own scan job and its own attest job, the attest waiting on its own scan.
// The checks are the single-image ones applied to each suffix, and no job may
// read the other image's outputs, so an unscanned or misnamed image fails.
const PAIR_SUFFIXES = ['service', 'migrate'];

export function pairProblems(source, { file, images }) {
  if (images.length !== PAIR_SUFFIXES.length) return ['a pair names exactly two images'];
  const found = [];
  const text = uncommented(source);
  const jobs = parseJobs(text, false);
  const { push } = jobs;
  if (!push) return ['there is no push job'];

  const top = text.split(/^jobs:\n/m)[0];
  if (/:\s*write(-all)?\s*$|^\s*permissions:\s*write-all/m.test(top)) {
    found.push('top-level permissions grant a write scope');
  }
  if (/id-token|attestations:/.test(push.text)) {
    found.push('push job holds a signing grant; only attest may');
  }
  if (
    /attest-build-provenance|attestation verify|prove-wrong-identity|\.\/\.github\/actions\//.test(
      text
    )
  ) {
    found.push('the workflow carries its own copy of the attest or verify step');
  }

  const wanted = {
    contents: 'read',
    packages: 'write',
    'id-token': 'write',
    attestations: 'write',
  };
  images.forEach((image, i) => {
    const s = PAIR_SUFFIXES[i];
    const other = PAIR_SUFFIXES[1 - i];
    const scan = jobs[`scan-${s}`];
    const attest = jobs[`attest-${s}`];
    if (!scan) return found.push(`there is no scan-${s} job`);
    if (!attest) return found.push(`there is no attest-${s} job`);

    // The push job publishes this image's reference and digest, read back from the store.
    if (
      !new RegExp(
        `^ {6}${s}-image: \\$\\{\\{ steps\\.digest\\.outputs\\.${s}-image \\}\\}$`,
        'm'
      ).test(push.text)
    ) {
      found.push(`push job does not output the ${s} reference`);
    }
    if (
      !new RegExp(
        `^ {6}${s}-digest: \\$\\{\\{ steps\\.digest\\.outputs\\.${s}-digest \\}\\}$`,
        'm'
      ).test(push.text)
    ) {
      found.push(`push job does not output the ${s} digest`);
    }
    if (!new RegExp(`echo "${s}-image=\\$[A-Z_]+@\\$${s}_digest"`).test(push.text)) {
      found.push(`the ${s} reference is not image@digest read back from the image store`);
    }

    // The scan: waits on push, the shared workflow at the pinned release, this image's
    // reference only, nothing that softens it.
    if (JSON.stringify(needsOf(scan.text)) !== JSON.stringify(['push'])) {
      found.push(`scan-${s} does not wait on push`);
    }
    const scanUses = /^ {4}uses: (.+)$/m.exec(scan.text);
    if (!scanUses || scanUses[1].trim() !== SCAN_USES) {
      found.push(`scan-${s} does not call image-scan.yml at the pinned v1.2.7`);
    }
    const scanWith = withKeys(scan.text);
    if (scanWith.image !== `\${{ needs.push.outputs.${s}-image }}`) {
      found.push(`scan-${s} does not scan the pushed ${s} reference`);
    }
    if (Object.keys(scanWith).some((k) => k !== 'image')) {
      found.push(`scan-${s} passes an input other than the image`);
    }
    if (
      JSON.stringify(permissionsOf(scan.text)) !==
      JSON.stringify({ contents: 'read', packages: 'read' })
    ) {
      found.push(`scan-${s} permissions are not exactly contents: read, packages: read`);
    }
    for (const [name, job] of [
      [`scan-${s}`, scan],
      [`attest-${s}`, attest],
    ]) {
      if (/continue-on-error|\|\| true/.test(job.text))
        found.push(`${name} job swallows a failure`);
      if (/^ {4}if:/m.test(job.text)) found.push(`${name} job can be skipped by a condition`);
    }

    // The attest: after its own scan, from the shared action, on this image's digest.
    const needs = needsOf(attest.text);
    if (needs.length !== 2 || !needs.includes('push') || !needs.includes(`scan-${s}`)) {
      found.push(`attest-${s} does not wait on both push and scan-${s}`);
    }
    const attestUses = [...attest.text.matchAll(/^\s*uses: (\S.*)$/gm)].map((m) => m[1].trim());
    if (!attestUses.includes(ATTEST_USES)) {
      found.push(`attest-${s} does not call attest-and-verify-image at the pinned v1.2.7`);
    }
    if (
      !new RegExp(`^ {10}digest: \\$\\{\\{ needs\\.push\\.outputs\\.${s}-digest \\}\\}$`, 'm').test(
        attest.text
      )
    ) {
      found.push(`attest-${s} does not attest the pushed ${s} digest`);
    }
    if (!attest.text.split('\n').includes(`      IMAGE: ${image}`)) {
      found.push(`attest-${s} does not name ${image}`);
    }
    if (!/^ {10}image: \$\{\{ env\.IMAGE \}\}$/m.test(attest.text)) {
      found.push(`attest-${s} does not pass the image name`);
    }
    const signers = [...attest.text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]);
    if (signers.length !== 1 || signers[0] !== `${REPO}/.github/workflows/${file}`) {
      found.push(`attest-${s} signer-workflow is not the literal path of this workflow`);
    }
    if (!new RegExp(`^ {10}repo: ${REPO}$`, 'm').test(attest.text)) {
      found.push(`attest-${s} does not name the repository literally`);
    }
    if (JSON.stringify(permissionsOf(attest.text)) !== JSON.stringify(wanted)) {
      found.push(`attest-${s} permissions are not exactly the four the action needs`);
    }

    // No cross-wiring: neither job reads the other image's outputs.
    if (scan.text.includes(`needs.push.outputs.${other}-`)) {
      found.push(`scan-${s} reads the ${other} image's outputs`);
    }
    if (attest.text.includes(`needs.push.outputs.${other}-`)) {
      found.push(`attest-${s} reads the ${other} image's outputs`);
    }
  });
  found.push(...sharedPinProblems(text));
  return found;
}

function pairedTests(file, images) {
  const real = read(file);

  test(`${file}: pushes two images, scans each before its attest`, () => {
    assert.deepEqual(pairProblems(real, { file, images }), []);
  });

  test(`${file}: the checker reports each way either image's scan-before-attest can break`, () => {
    const cases = [];
    images.forEach((image, i) => {
      const s = PAIR_SUFFIXES[i];
      const other = PAIR_SUFFIXES[1 - i];
      const scanJob = new RegExp(`\\n {2}scan-${s}:\\n[\\s\\S]*?(?=\\n {2}[a-z][\\w-]*:\\n)`).exec(
        real
      );
      assert.ok(scanJob, `the real text has a scan-${s} job`);
      const withScan = (from, to) => {
        assert.ok(scanJob[0].includes(from), `the scan-${s} job contains ${JSON.stringify(from)}`);
        return real.replace(scanJob[0], scanJob[0].replace(from, to));
      };
      cases.push(
        // The scan for this image is removed, or no longer gates its attest.
        [real.replace(scanJob[0], ''), `there is no scan-${s} job`],
        [withScan('    needs: push\n', ''), `scan-${s} does not wait on push`],
        [
          swap(real, `    needs: [push, scan-${s}]\n`, '    needs: [push]\n'),
          `attest-${s} does not wait on both push and scan-${s}`,
        ],
        [
          swap(
            real,
            `    needs: [push, scan-${s}]\n`,
            `    needs: [push, scan-${s}]\n    if: always()\n`
          ),
          `attest-${s} job can be skipped by a condition`,
        ],
        // The scan runs on the other image, or softens, for this image.
        [
          withScan(
            `image: \${{ needs.push.outputs.${s}-image }}`,
            `image: \${{ needs.push.outputs.${other}-image }}`
          ),
          `scan-${s} does not scan the pushed ${s} reference`,
        ],
        [
          withScan('    with:\n', '    with:\n      allow-empty-sbom: true\n'),
          `scan-${s} passes an input other than the image`,
        ],
        [
          withScan('    uses: ', '    continue-on-error: true\n    uses: '),
          `scan-${s} job swallows a failure`,
        ],
        // The attest names the other image's digest, or the other image's name.
        [
          swap(
            real,
            `digest: \${{ needs.push.outputs.${s}-digest }}`,
            `digest: \${{ needs.push.outputs.${other}-digest }}`
          ),
          `attest-${s} does not attest the pushed ${s} digest`,
        ],
        [
          swap(real, `      IMAGE: ${image}\n`, `      IMAGE: ${images[1 - i]}\n`),
          `attest-${s} does not name ${image}`,
        ],
        // The shared attest is floated to a branch rather than the pin.
        [
          swap(real, `attest-and-verify-image@${PIN}`, 'attest-and-verify-image@main'),
          'github-workflows reference is not pinned to v1.2.7',
        ]
      );
    });
    for (const [text, expected] of cases) {
      assert.notEqual(text, real, `the sabotage changed the text for: ${expected}`);
      const found = pairProblems(text, { file, images });
      assert.ok(
        found.some((p) => p.includes(expected)),
        `expected "${expected}", got ${JSON.stringify(found)}`
      );
    }
  });
}

const hasProblem = (list, expected) => list.some((p) => p.includes(expected));

for (const [file, value] of Object.entries(PUBLISHERS)) {
  if (Array.isArray(value)) {
    pairedTests(file, value);
    continue;
  }
  const image = value;
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
      [swap(real, `image-scan.yml@${PIN} # v1.2.7`, `image-scan.yml@${PIN}`), 'pinned to v1.2.7'],
      [swap(real, `image-scan.yml@${PIN} # v1.2.7`, 'image-scan.yml@v1.0.6'), 'pinned to v1.2.7'],
      [
        swap(real, `attest-and-verify-image@${PIN} # v1.2.7`, 'attest-and-verify-image@main'),
        'pinned to v1.2.7',
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
  for (const file of ['odask-image.yml']) {
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

// The scan reads this file by default, so a workflow that passes no
// `exemptions-path` still gets it. Format: the v1.1.0 image-scan README.
const EXEMPTIONS_FILE = '.image-scan-exemptions.json';
const EXEMPTION_KEYS = [
  'vulnerability',
  'package',
  'image',
  'reason',
  'granted',
  'expires',
  'approved-by',
];
const EXEMPTION_REQUIRED = EXEMPTION_KEYS.filter((k) => k !== 'approved-by');
const DAY_MS = 24 * 60 * 60 * 1000;

// workflow file -> the exemptions-path it passes. Empty today: the default
// path is the file, so no workflow needs to name it. Adding a name here is a
// conscious edit, and the checker above must then allow the extra scan input.
const WIRES_EXEMPTIONS = {};

function dayOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const t = Date.parse(`${value}T00:00:00Z`);
  return new Date(t).toISOString().startsWith(value) ? t : NaN;
}

// Problems with an exemption file's text, per the v1.1.0 format. Only what can
// be known without the scan: the scan itself judges expiry against today.
export function exemptionProblems(source) {
  let data;
  try {
    data = JSON.parse(source);
  } catch {
    return ['the exemption file is not JSON'];
  }
  if (!data || Array.isArray(data) || !Array.isArray(data.exemptions)) {
    return ['the exemption file has no exemptions array'];
  }
  if (Object.keys(data).some((k) => k !== 'exemptions')) {
    return ['the exemption file has a key other than exemptions'];
  }
  const found = [];
  const images = new Set(Object.values(PUBLISHERS).flat());
  for (const entry of data.exemptions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      found.push('an exemption is not an object');
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!EXEMPTION_KEYS.includes(key)) found.push(`an exemption has the unknown key ${key}`);
    }
    for (const key of EXEMPTION_REQUIRED) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        found.push(`an exemption has no ${key}`);
      }
    }
    if ('approved-by' in entry && String(entry['approved-by']).trim() === '') {
      found.push('an exemption has a blank approved-by');
    }
    if (typeof entry.reason === 'string' && entry.reason.length > 500) {
      found.push('an exemption reason is over 500 characters');
    }
    if (typeof entry.image === 'string' && !images.has(entry.image)) {
      found.push(`an exemption names an image no workflow here publishes: ${entry.image}`);
    }
    const granted = dayOf(entry.granted);
    const expires = dayOf(entry.expires);
    if (Number.isNaN(granted) || Number.isNaN(expires)) {
      found.push('an exemption date is not a real YYYY-MM-DD');
    } else if (expires < granted || expires - granted > 30 * DAY_MS) {
      found.push('an exemption expires before it is granted or more than 30 days after');
    }
  }
  return found;
}

// The file the scan reads, when there is one. A missing file means no exemptions.
const exemptionsPath = path.join(ROOT, EXEMPTIONS_FILE);
const exemptionsText = () => fs.readFileSync(exemptionsPath, 'utf8');

test('an exemption file, when present, is in the v1.1.0 format', () => {
  if (!fs.existsSync(exemptionsPath)) return;
  assert.deepEqual(exemptionProblems(exemptionsText()), []);
});

test('the checker reports each way the exemption file can be malformed', () => {
  const entry = {
    vulnerability: 'CVE-2026-0001',
    package: 'libexample',
    image: PUBLISHERS['demo-edge-image.yml'],
    reason: 'a reason',
    granted: '2026-11-10',
    expires: '2026-12-10',
  };
  const file = (changes) => JSON.stringify({ exemptions: [{ ...entry, ...changes }] });
  assert.deepEqual(exemptionProblems(file({})), []);
  const cases = [
    ['{', 'is not JSON'],
    ['[]', 'no exemptions array'],
    [JSON.stringify({ exemptions: [], extra: 1 }), 'key other than exemptions'],
    [file({ image: undefined }), 'has no image'],
    [file({ reason: ' ' }), 'has no reason'],
    [file({ reason: 'x'.repeat(501) }), 'over 500 characters'],
    [file({ image: 'ghcr.io/branchleft/not-published' }), 'no workflow here publishes'],
    [file({ 'approved-by': ' ' }), 'blank approved-by'],
    [file({ owner: 'someone' }), 'unknown key owner'],
    [file({ granted: '2026-02-31' }), 'not a real YYYY-MM-DD'],
    [file({ expires: '2026-12-11' }), 'more than 30 days after'],
    [file({ expires: '2026-11-09' }), 'before it is granted'],
  ];
  for (const [text, expected] of cases) {
    const found = exemptionProblems(text);
    assert.ok(hasProblem(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

test('only the allow-listed workflows pass exemptions-path, each at a file that exists', () => {
  const wired = {};
  for (const file of Object.keys(PUBLISHERS)) {
    const m = /^\s*exemptions-path:\s*(\S+)\s*$/m.exec(uncommented(read(file)));
    if (m) wired[file] = m[1];
  }
  assert.deepEqual(wired, WIRES_EXEMPTIONS);
  for (const [file, wiredPath] of Object.entries(wired)) {
    assert.ok(
      fs.existsSync(path.join(ROOT, wiredPath)),
      `${file} points at ${wiredPath}, which is missing`
    );
  }
  // The input name appears nowhere else in a publisher, in any spelling.
  for (const file of Object.keys(PUBLISHERS)) {
    const count = (uncommented(read(file)).match(/exemptions-path/g) ?? []).length;
    assert.equal(count, file in WIRES_EXEMPTIONS ? 1 : 0, `${file} mentions exemptions-path`);
  }
});

// The owner's 30-day acceptance of five OpenSSL findings no update can clear:
// the system libssl and libcrypto packages of the tenant and portal images,
// granted 2026-11-23, lapsing 2026-12-23, and of the demo gate image, granted
// 2026-11-24, lapsing 2026-12-24. The exemption file may hold exactly these
// thirty entries (five advisories, two packages, three images) for those
// packages, and nothing else for those three images. Widening it by an advisory,
// a package or an image, or giving an entry no expiry or a later one, fails
// here. Removing the entries is the follow-up that ends the acceptance, and it
// removes this block with them.
const OPENSSL_VULNERABILITIES = [
  'CVE-2026-107493',
  'CVE-2026-107494',
  'CVE-2026-121482',
  'CVE-2026-124709',
  'CVE-2026-84786',
];
const OPENSSL_PACKAGES = ['libcrypto3', 'libssl3'];
// The demo gate is a third image in the same acceptance, granted a day later
// (2026-11-24) for its own 30 days. Its extension is pending the owner's
// confirmation; the 2026-11-23 decision named only the first two images.
const DEMO_GATE_IMAGE = 'ghcr.io/branchleft/demo-gate';
const OPENSSL_IMAGES = [
  PUBLISHERS['registry-push.yml'],
  PUBLISHERS['portal-apps-image.yml'],
  DEMO_GATE_IMAGE,
];
const OPENSSL_GRANTED = '2026-11-23';
const OPENSSL_EXPIRES = '2026-12-23';
const grantedFor = (image) => (image === DEMO_GATE_IMAGE ? '2026-11-24' : OPENSSL_GRANTED);
const expiresFor = (image) => (image === DEMO_GATE_IMAGE ? '2026-12-24' : OPENSSL_EXPIRES);

export function opensslExemptionProblems(source) {
  const data = JSON.parse(source);
  const found = [];
  const seen = new Map();
  for (const entry of data.exemptions) {
    const touches =
      OPENSSL_IMAGES.includes(entry.image) || OPENSSL_PACKAGES.includes(entry.package);
    if (!touches) continue;
    const id = `${entry.vulnerability} in ${entry.package} of ${entry.image}`;
    const inScope =
      OPENSSL_VULNERABILITIES.includes(entry.vulnerability) &&
      OPENSSL_PACKAGES.includes(entry.package) &&
      OPENSSL_IMAGES.includes(entry.image);
    if (!inScope) {
      found.push(`${id} is outside the five advisories, two packages and three images accepted`);
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (entry.granted !== grantedFor(entry.image))
      found.push(`${id} is not granted on ${grantedFor(entry.image)}`);
    if (entry.expires !== expiresFor(entry.image))
      found.push(`${id} does not expire on ${expiresFor(entry.image)}`);
    if (typeof entry['approved-by'] !== 'string' || entry['approved-by'].trim() === '') {
      found.push(`${id} names no approved-by`);
    }
  }
  for (const vulnerability of OPENSSL_VULNERABILITIES) {
    for (const pkg of OPENSSL_PACKAGES) {
      for (const image of OPENSSL_IMAGES) {
        const id = `${vulnerability} in ${pkg} of ${image}`;
        const count = seen.get(id) ?? 0;
        if (count !== 1) found.push(`${id} appears ${count} times, not once`);
      }
    }
  }
  return found;
}

test('the OpenSSL exemption holds exactly the accepted scope and its 30-day expiry', () => {
  assert.deepEqual(opensslExemptionProblems(exemptionsText()), []);
});

test('the OpenSSL exemption check fails when the scope is widened or the expiry lost', () => {
  const real = JSON.parse(exemptionsText());
  const sample = real.exemptions.find((e) => OPENSSL_IMAGES.includes(e.image));
  assert.ok(sample, 'the file holds no OpenSSL entry to mutate');
  const mutate = (change) => {
    const copy = structuredClone(real);
    change(
      copy.exemptions,
      copy.exemptions.indexOf(copy.exemptions.find((e) => OPENSSL_IMAGES.includes(e.image)))
    );
    return JSON.stringify(copy);
  };
  // The demo-gate entries carry their own dates: a demo-gate entry given the
  // tenant and portal dates (granted 2026-11-23, expiring 2026-12-23) must fail.
  const mutateDemoGate = (change) => {
    const copy = structuredClone(real);
    change(
      copy.exemptions,
      copy.exemptions.findIndex((e) => e.image === DEMO_GATE_IMAGE)
    );
    return JSON.stringify(copy);
  };
  const cases = [
    [mutateDemoGate((all, i) => (all[i].expires = '2026-12-23')), 'does not expire on 2026-12-24'],
    [mutateDemoGate((all, i) => (all[i].granted = '2026-11-23')), 'is not granted on 2026-11-24'],
    [
      mutate((all) => all.push({ ...sample, vulnerability: 'CVE-2026-107496' })),
      'outside the five',
    ],
    [mutate((all) => all.push({ ...sample, package: 'libxml2' })), 'outside the five'],
    [mutate((all) => all.push({ ...sample, package: '*' })), 'outside the five'],
    [mutate((all) => all.push({ ...sample, vulnerability: '*' })), 'outside the five'],
    [
      mutate((all) => all.push({ ...sample, image: 'ghcr.io/branchleft/demo-edge' })),
      'outside the five',
    ],
    [mutate((all, i) => delete all[i].expires), 'does not expire on'],
    [mutate((all, i) => (all[i].expires = '2026-12-24')), 'does not expire on'],
    [mutate((all, i) => (all[i].granted = '2026-11-22')), 'is not granted on'],
    [mutate((all, i) => delete all[i]['approved-by']), 'names no approved-by'],
    [mutate((all, i) => all.splice(i, 1)), 'appears 0 times'],
    [mutate((all) => all.push({ ...sample })), 'appears 2 times'],
  ];
  for (const [text, expected] of cases) {
    const found = opensslExemptionProblems(text);
    assert.ok(
      found.some((p) => p.includes(expected)),
      `expected "${expected}", got ${JSON.stringify(found)}`
    );
  }
});

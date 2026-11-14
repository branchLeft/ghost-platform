import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GUARD,
  normalise,
  parseJobs,
  problems as publishProblems,
  withoutComments,
} from './test-support/publish-job-checks.mjs';

// The demo gate's image is a control: the demo edge's forward_auth trusts what
// this image answers. So the workflow that publishes it must follow the proof,
// run only from main, hold the write and signing credentials in the push and
// attest jobs alone, publish the image the proof tested, and refuse to finish
// without a verified digest. The Dockerfile must carry the base pin and the
// hardening the scanned portal image carries, and must not ship npm or pnpm.
// Each case below breaks one property in a copy of the real text and requires a
// named problem, so a passing run means the check can see the break.
const ROOT = import.meta.dirname;
const WORKFLOW_PATH = '.github/workflows/demo-gate-image.yml';
const REPO = 'branchLeft/ghost-platform';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const WORKFLOW = read(WORKFLOW_PATH);
const DOCKERFILE = read('services/demo-gate/Dockerfile');

// The base the image scan judged: node:26.13.0-alpine, linux/amd64 manifest.
// The same digest portal/Dockerfile pins.
const BASE =
  'node:26.13.0-alpine@sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a';
const PNPM = 'pnpm@11.17.0';

// Whole-line comments and trailing ones (a `#` after whitespace) both go, so
// text inside a comment can never satisfy a check.
const dockerText = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');

// Replace text that must be there: a mutation that silently changed nothing
// would let its case pass without proving anything.
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

const hasProblem = (list, expected) => list.some((p) => p.includes(expected));

// The proofs the build job runs, in the order they must run, and the save that
// must come after every one of them.
const PROOFS = [
  './scripts/test-demo-gate.sh demo-gate:ci',
  './scripts/test-demo-edge.sh demo-gate:ci',
  'DEMO_EDGE_PROOF_SABOTAGE=exempt-ghost',
  'DEMO_EDGE_PROOF_SABOTAGE=narrow-import',
  'DEMO_EDGE_PROOF_SABOTAGE=drop-upload-guard',
];

export function workflowProblems(source) {
  const found = [...publishProblems(source)];
  const text = withoutComments(source);
  const top = text.split(/^jobs:\n/m)[0];
  const jobs = parseJobs(source);
  const { build, push, scan, attest } = jobs;

  if (!/^permissions:\n {2}contents: read\n {2}packages: read\n(?! {2}\S)/m.test(top)) {
    found.push('top-level permissions are not exactly contents: read and packages: read');
  }
  const signers = [...text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]);
  if (signers.length !== 1 || signers[0] !== `${REPO}/${WORKFLOW_PATH}`) {
    found.push('signer-workflow is not the literal path of this workflow');
  }
  if (/workflow_ref/.test(text)) found.push('an identity is read from the run itself');
  if (!scan || !attest) return [...found, 'there is no scan or attest job'];
  for (const grant of ['id-token: write', 'attestations: write']) {
    if (text.split(grant).length - 1 !== 1 || !attest.text.includes(grant)) {
      found.push(`${grant} is not on the attest job alone`);
    }
  }
  if (text.split('packages: write').length - 1 !== 2 || !push.text.includes('packages: write')) {
    found.push('packages: write is not on the push and attest jobs alone');
  }
  if (/:latest/.test(text)) found.push('an image is tagged latest');
  if (!/IMAGE_TAG: \$\{\{ github\.sha \}\}/.test(push.text)) {
    found.push('the push job does not tag with the commit SHA');
  }
  if (!/^ {6}IMAGE: ghcr\.io\/branchleft\/demo-gate$/m.test(push.text)) {
    found.push('the push job does not publish ghcr.io/branchleft/demo-gate');
  }
  if (!/docker build[^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*--platform linux\/amd64/.test(build.text)) {
    found.push('the build job does not name --platform linux/amd64');
  }
  if (!/node --test workflow-demo-gate-image\.test\.js/.test(build.text)) {
    found.push('the build job does not run the workflow and Dockerfile tests');
  }
  if (!/--provenance=false/.test(build.text) || !/--sbom=false/.test(build.text)) {
    found.push('the build job does not turn off provenance and SBOM, so the digest would drift');
  }

  // The proof runs in full before anything is saved, and the save and the
  // image ID are the last steps of the build job.
  const saveAt = build.text.indexOf('docker save');
  for (const proof of PROOFS) {
    const at = build.text.indexOf(proof);
    if (at < 0) found.push(`the build job does not run ${proof}`);
    else if (saveAt < at) found.push('the save comes before a proof or sabotage step');
  }
  if (!/"\$loaded" != "\$PROVEN_ID"/.test(push.text)) {
    found.push('the push job does not refuse a loaded image that is not the proven one');
  }

  if (
    !push.text.includes('id: digest') ||
    !/digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/.test(push.text)
  ) {
    found.push('push job does not read the digest back and output it');
  }
  if (!/Pin this: /.test(push.text)) found.push('push job summary lacks "Pin this:"');
  if (
    !/uses: branchLeft\/github-workflows\/\.github\/actions\/attest-and-verify-image@/.test(
      attest.text
    )
  ) {
    found.push('attest job does not call the shared attest and verify action');
  }
  if (!/^ {4}needs: \[push, scan\]$/m.test(attest.text)) {
    found.push('attest job does not wait on the push and the scan');
  }
  if (!/^ {4}needs: push$/m.test(scan.text) || !/image-scan\.yml@/.test(scan.text)) {
    found.push('scan job does not run the shared image scan after the push');
  }
  if (jobs['anonymous-pull']) {
    found.push('there is an anonymous-pull job; demo1 takes a saved tar, not a GHCR pull');
  }
  const checkouts = (text.match(/actions\/checkout@/g) ?? []).length;
  const unpersisted = (text.match(/persist-credentials: false/g) ?? []).length;
  if (checkouts === 0 || checkouts !== unpersisted) {
    found.push('a checkout keeps its credentials');
  }
  return found;
}

test('the real Dockerfile pins the scanned base and keeps the portal hardening', () => {
  assert.deepEqual(dockerfileProblems(DOCKERFILE), []);
});

test('the real publish workflow is gated, scoped, digest-verified, signed and scanned', () => {
  assert.deepEqual(workflowProblems(WORKFLOW), []);
});

test('the real Dockerfile pnpm pin is the one the package pins', () => {
  const pkg = JSON.parse(read('services/demo-gate/package.json'));
  assert.equal(pkg.packageManager, PNPM);
});

test('the real gate package depends at run time on link: packages and the pinned render-core only', () => {
  const pkg = JSON.parse(read('services/demo-gate/package.json'));
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (name === '@branchleft/ghost-platform-render-core') {
      assert.match(spec, /^\d+\.\d+\.\d+$/, `${name} is pinned to one published version`);
    } else {
      assert.match(spec, /^link:/, `${name} is a link package, so the image ships no npm package`);
    }
  }
});

// Problems with the Dockerfile's text, against the hardening the portal image
// applies to the same base, plus the removal of pnpm this image adds.
export function dockerfileProblems(source) {
  const text = dockerText(source);
  const found = [];
  const froms = text.split('\n').filter((line) => /^\s*FROM\s/.test(line));
  if (froms.length !== 1 || froms[0] !== `FROM ${BASE}`) {
    found.push('the base image is not the one FROM line pinned to the scanned digest');
  }
  if (/^FROM\s+[^\s@]+\s*$/m.test(text)) found.push('the base image is a bare tag');
  if (!/^RUN apk upgrade --no-cache zlib$/m.test(text)) {
    found.push('zlib is not upgraded past CVE-2026-4738 before anything else runs');
  }
  const runs = text.split(/^RUN\s/m).slice(1);
  const install = runs.find((run) => run.includes('pnpm install'));
  if (!install) return [...found, 'there is no install RUN'];
  if (!install.includes(`npm install --global ${PNPM};`)) {
    found.push(`the install RUN does not install exactly ${PNPM} globally`);
  }
  if (!/--mount=type=secret,id=node_auth_token/.test(install)) {
    found.push('the install RUN does not mount the token as a secret');
  }
  if (/^(ARG|ENV)\b[^\n]*(token|TOKEN)/m.test(text)) {
    found.push('the token arrives as an ARG or ENV, so it would sit in the build history');
  }
  if (!/pnpm install --frozen-lockfile/.test(install)) {
    found.push('the install RUN does not install with the frozen lockfile');
  }
  if (!/rm -rf \/usr\/local\/lib\/node_modules\/npm\b/.test(install)) {
    found.push('npm is not removed in the install RUN');
  }
  if (!/rm -rf \/usr\/local\/lib\/node_modules\/pnpm\b/.test(install)) {
    found.push('pnpm itself is not removed in the install RUN');
  }
  if (!/pnpm store path/.test(install) || !/rm -rf "\$store"/.test(install)) {
    found.push('the pnpm store is not removed in the install RUN');
  }
  if (!/rm -f \/tmp\/npmrc/.test(install)) {
    found.push('the token userconfig is not removed in the install RUN');
  }
  if (
    install.indexOf('pnpm store path') > install.indexOf('rm -rf /usr/local/lib/node_modules/pnpm')
  ) {
    found.push('the pnpm store path is read after pnpm is removed');
  }
  if (!/^USER node$/m.test(text)) found.push('the image does not run as USER node');
  if (/^USER (root|0)\b/m.test(text)) found.push('the image runs as root');
  if (!/^CMD \["node", "dist\/server\.js"\]$/m.test(text)) {
    found.push('the command is not node dist/server.js');
  }
  return found;
}

test('the workflow checker reports each way the publish workflow can go wrong', () => {
  const cases = [
    [
      swap(
        WORKFLOW,
        "(github.event_name == 'workflow_dispatch' || github.event_name == 'push')",
        "(github.event_name != 'x')"
      ),
      'exactly the main-only',
    ],
    [
      swap(WORKFLOW, "github.ref == 'refs/heads/main' &&\n      (", 'always() ||\n      ('),
      'exactly the main-only',
    ],
    [swap(WORKFLOW, '    needs: build\n', ''), 'does not wait on the proof job'],
    [
      swap(
        WORKFLOW,
        '      - name: Push\n',
        '      - name: Rebuild\n        run: docker build --tag "$IMAGE:$IMAGE_TAG" services/demo-gate\n\n      - name: Push\n'
      ),
      'rebuilds',
    ],
    [
      swap(
        WORKFLOW,
        '      - name: Push\n',
        '      - name: Tag\n        run: docker tag demo-gate:ci "$IMAGE:latest"\n\n      - name: Push\n'
      ),
      'latest',
    ],
    [
      swap(
        WORKFLOW,
        '    permissions:\n      contents: read\n      packages: write\n\n    # One publish',
        '    permissions:\n      contents: read\n      packages: write\n      id-token: write\n\n    # One publish'
      ),
      'not on the attest job alone',
    ],
    [
      swap(
        WORKFLOW,
        'signer-workflow: branchLeft/ghost-platform/.github/workflows/demo-gate-image.yml',
        'signer-workflow: ${{ github.workflow_ref }}'
      ),
      'signer-workflow is not the literal',
    ],
    [swap(WORKFLOW, '            --platform linux/amd64 \\\n', ''), '--platform linux/amd64'],
    [
      swap(
        WORKFLOW,
        '      - name: Real-Caddy proof (no cookie',
        '      - name: Early save\n        run: docker save --output early.tar demo-gate:ci\n\n      - name: Real-Caddy proof (no cookie'
      ),
      'the save comes before a proof',
    ],
    [
      swap(
        WORKFLOW,
        'if [ -z "$PROVEN_ID" ] || [ "$loaded" != "$PROVEN_ID" ]; then',
        'if false; then'
      ),
      'refuse a loaded image',
    ],
    [
      swap(WORKFLOW, "grep -Eq '^sha256:[0-9a-f]{64}$'", "grep -Eq '.*'"),
      'does not refuse a malformed digest',
    ],
    [
      swap(WORKFLOW, '    needs: [push, scan]\n', '    needs: [push]\n'),
      'wait on the push and the scan',
    ],
    [
      swap(WORKFLOW, '    needs: [push, scan]\n', '    needs: [scan]\n'),
      'wait on the push and the scan',
    ],
    [
      swap(WORKFLOW, 'run: node --test workflow-demo-gate-image.test.js', 'run: "true"'),
      'workflow and Dockerfile tests',
    ],
    [swap(WORKFLOW, 'Pin this:', 'Pinned:'), 'lacks "Pin this:"'],
    [
      `${WORKFLOW}\n  anonymous-pull:\n    name: Pull\n    runs-on: ubuntu-latest\n    needs: [push, attest]\n    steps:\n      - run: "true"\n`,
      'anonymous-pull',
    ],
  ];
  for (const [text, expected] of cases) {
    const found = workflowProblems(text);
    assert.ok(hasProblem(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
  assert.ok(
    normalise(parseJobs(WORKFLOW).push.condition) === GUARD,
    'the real push job carries the main-only guard'
  );
});

test('the Dockerfile checker reports each way the image can go wrong', () => {
  const cases = [
    [swap(DOCKERFILE, `FROM ${BASE}`, 'FROM node:26.13.0-alpine'), 'base image'],
    [swap(DOCKERFILE, `FROM ${BASE}`, `FROM ${BASE.replace('b2646', 'c2646')}`), 'base image'],
    [swap(DOCKERFILE, 'RUN apk upgrade --no-cache zlib', 'RUN true'), 'zlib'],
    [
      swap(
        DOCKERFILE,
        'rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx; \\\n',
        ''
      ),
      'npm is not removed',
    ],
    [
      swap(DOCKERFILE, 'rm -rf /usr/local/lib/node_modules/pnpm', 'true'),
      'pnpm itself is not removed',
    ],
    [swap(DOCKERFILE, 'rm -rf "$store"', 'true'), 'pnpm store is not removed'],
    [swap(DOCKERFILE, 'rm -f /tmp/npmrc', 'true'), 'token userconfig is not removed'],
    [swap(DOCKERFILE, `FROM ${BASE}`, `ARG NODE_AUTH_TOKEN\nFROM ${BASE}`), 'ARG or ENV'],
    [
      swap(DOCKERFILE, 'RUN --mount=type=secret,id=node_auth_token \\\n', 'RUN \\\n'),
      'mount the token as a secret',
    ],
    [swap(DOCKERFILE, 'USER node', 'USER root'), 'USER node'],
    [swap(DOCKERFILE, 'USER node', 'USER node\nUSER root'), 'runs as root'],
    [
      swap(DOCKERFILE, `npm install --global ${PNPM};`, 'npm install --global pnpm@11.28.11;'),
      `exactly ${PNPM}`,
    ],
    [
      swap(
        DOCKERFILE,
        'pnpm install --frozen-lockfile && pnpm run build',
        'pnpm install && pnpm run build'
      ),
      'frozen lockfile',
    ],
    [swap(DOCKERFILE, 'CMD ["node", "dist/server.js"]', 'CMD ["npm", "start"]'), 'command is not'],
  ];
  for (const [text, expected] of cases) {
    const found = dockerfileProblems(text);
    assert.ok(hasProblem(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

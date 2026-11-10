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
import { compareReports, problems as pinProblems, readPins } from './scripts/demo-edge-pins.mjs';

// A production host runs this image, so two things are controls: the pins in
// services/demo-edge/Dockerfile (Caddy and the Hetzner module) must agree with
// each other and with the binary built from them, and the workflow that
// publishes it must follow the proof, run only from main, hold the write and
// signing credentials in the push job alone, publish the image the proof
// tested, and refuse to finish without a verified digest. Each case below
// breaks one of those in a copy of the real text and requires a named problem.
const ROOT = import.meta.dirname;
const WORKFLOW_PATH = '.github/workflows/demo-edge-image.yml';
const WORKFLOW = fs.readFileSync(path.join(ROOT, WORKFLOW_PATH), 'utf8');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'services', 'demo-edge', 'Dockerfile'), 'utf8');

// What the built binary printed, read from a real build of this Dockerfile
// (`caddy version`, `caddy list-modules --versions`, `caddy build-info`).
const OBSERVED = {
  version: 'v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=\n',
  modules: [
    'dns.providers.hetzner v2.0.1',
    'http.handlers.reverse_proxy',
    'tls.issuance.acme',
    '',
    '  Standard modules: 119',
    '  Non-standard modules: 1',
    '',
  ].join('\n'),
  buildInfo: [
    'go\tgo1.26.8',
    'path\tcaddy',
    'mod\tcaddy\t(devel)\t',
    'dep\tgithub.com/caddy-dns/hetzner/v2\tv2.0.1\th1:lNv0M68UOtuBPLQ8VBeu7nByMNl+gRRa2B2H4RgMbYI=',
    'dep\tgithub.com/caddyserver/caddy/v2\tv2.11.4\th1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=',
    'build\t-trimpath=true',
    '',
  ].join('\n'),
  arch: 'amd64',
};

// Replace text that must be there: a mutation that silently changed nothing
// would let its case pass without proving anything.
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

function demoEdgeProblems(source) {
  const found = [...publishProblems(source)];
  const text = withoutComments(source);
  const top = text.split(/^jobs:\n/m)[0];
  const jobs = parseJobs(source);
  const { build, push, scan, attest } = jobs;
  const pull = jobs['anonymous-pull'];

  if (!/^permissions:\n {2}contents: read\n(?! {2}\S)/m.test(top)) {
    found.push('top-level permissions are not exactly contents: read');
  }
  const signers = [...text.matchAll(/^\s*signer-workflow: (\S+)\s*$/gm)].map((m) => m[1]);
  if (signers.length !== 1 || signers[0] !== `branchLeft/ghost-platform/${WORKFLOW_PATH}`) {
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
  if (!/IMAGE: ghcr\.io\/branchleft\/demo-edge$/m.test(push.text)) {
    found.push('the push job does not publish ghcr.io/branchleft/demo-edge');
  }
  if (!/docker build[^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*--platform linux\/amd64/.test(build.text)) {
    found.push('the build job does not name --platform linux/amd64');
  }
  if (!/node scripts\/demo-edge-pins\.mjs demo-edge:ci\s*$/m.test(build.text)) {
    found.push('the build job does not hold the built binary to the Dockerfile pins');
  }
  if (!/Dockerfile\.drifted/.test(build.text) || !/vacuous/.test(build.text)) {
    found.push('the build job does not prove a drifted pin is refused');
  }
  if (!/node --test workflow-demo-edge-image\.test\.js/.test(build.text)) {
    found.push('the build job does not run the workflow and pins tests');
  }
  if (
    !push.text.includes('id: digest') ||
    !/digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/.test(push.text)
  ) {
    found.push('push job does not read the digest back and output it');
  }
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
  if (!/Pin this: /.test(push.text)) found.push('push job summary lacks "Pin this:"');

  if (!pull) return [...found, 'there is no anonymous-pull job'];
  if (!/^ {4}needs: \[push, attest\]$/m.test(pull.text)) {
    found.push('anonymous-pull does not wait on push and attest');
  }
  if (normalise(pull.condition) !== GUARD) {
    found.push('anonymous-pull has no job-level guard that is exactly the main-only expression');
  }
  if (!/^ {4}permissions:\n {6}contents: read\n(?! {6}\S)/m.test(pull.text)) {
    found.push('anonymous-pull permissions are not exactly contents: read');
  }
  if (/login|secrets\.|GITHUB_TOKEN|docker\/login-action/i.test(pull.text)) {
    found.push('anonymous-pull logs in or reads a credential');
  }
  if (!/docker pull --platform linux\/amd64 "\$PINNED_IMAGE"/.test(pull.text)) {
    found.push('anonymous-pull does not pull the pinned digest for linux/amd64');
  }
  if (!/needs\.push\.outputs\.image/.test(pull.text)) {
    found.push('anonymous-pull does not take the digest from the push job');
  }
  if (!/node scripts\/demo-edge-pins\.mjs "\$PINNED_IMAGE"/.test(pull.text)) {
    found.push('anonymous-pull does not hold the pulled binary to the Dockerfile pins');
  }
  return found;
}

const hasProblem = (list, expected) => list.some((p) => p.includes(expected));

test('the real Dockerfile pins are coherent', () => {
  assert.deepEqual(pinProblems(DOCKERFILE), []);
});

test('the real Dockerfile pins agree with what the built binary reported', () => {
  assert.deepEqual(compareReports(readPins(DOCKERFILE), OBSERVED), []);
});

test('the real publish workflow is gated, scoped, digest-verified, signed and checked anonymously', () => {
  assert.deepEqual(demoEdgeProblems(WORKFLOW), []);
});

test('the pins checker reports each way the Dockerfile can drift', () => {
  const hetzner = 'github.com/caddy-dns/hetzner/v2@v2.0.1';
  const builderDigest = /(caddy:2\.11\.4-builder-alpine)@sha256:[0-9a-f]{64}/;
  const finalDigest = /(caddy:2\.11\.4-alpine)@sha256:[0-9a-f]{64}/;
  const cases = [
    [swap(DOCKERFILE, `@v2.0.1`, ''), 'not pinned to a vX.Y.Z version'],
    [swap(DOCKERFILE, '@v2.0.1', '@latest'), 'not pinned to a vX.Y.Z version'],
    [swap(DOCKERFILE, hetzner, 'github.com/caddy-dns/hetzner/v2@v2'), 'not pinned'],
    [DOCKERFILE.replace(builderDigest, '$1'), 'has no @sha256 digest pin'],
    [DOCKERFILE.replace(finalDigest, '$1'), 'has no @sha256 digest pin'],
    [DOCKERFILE.replace(builderDigest, '$1@sha256:abc'), 'has no @sha256 digest pin'],
    [swap(DOCKERFILE, 'caddy:2.11.4-alpine@', 'caddy:2.11.3-alpine@'), 'disagree'],
    [swap(DOCKERFILE, 'caddy:2.11.4-builder-alpine@', 'caddy:2.11.3-builder-alpine@'), 'disagree'],
    [swap(DOCKERFILE, 'xcaddy build v2.11.4', 'xcaddy build v2.11.3'), 'xcaddy build v2.11.3'],
    [swap(DOCKERFILE, 'xcaddy build v2.11.4 --with', 'xcaddy build --with'), 'no vX.Y.Z Caddy'],
    [swap(DOCKERFILE, 'xcaddy build v2.11.4', 'xcaddy build latest'), 'no vX.Y.Z Caddy'],
    [
      swap(DOCKERFILE, hetzner, `${hetzner} --with github.com/example/other@v1.0.0`),
      'unexpected module',
    ],
    [swap(DOCKERFILE, hetzner, 'github.com/example/other@v1.0.0'), 'does not name'],
    [`${DOCKERFILE}RUN xcaddy build v2.11.4 --with ${hetzner}\n`, 'exactly one xcaddy build'],
    [`${DOCKERFILE}FROM alpine:3.20\n`, 'exactly two FROM lines'],
    [swap(DOCKERFILE, 'FROM caddy:2.11.4-builder-alpine', 'FROM busybox:1'), 'not the caddy image'],
    [swap(DOCKERFILE, ' AS builder', ''), 'first FROM is not'],
  ];
  for (const [text, expected] of cases) {
    assert.ok(
      hasProblem(pinProblems(text), expected),
      `expected a problem containing "${expected}", got ${JSON.stringify(pinProblems(text))}`
    );
  }
});

test('a pin that only appears in a comment does not count', () => {
  const commented = swap(
    DOCKERFILE,
    'RUN xcaddy build v2.11.4 --with github.com/caddy-dns/hetzner/v2@v2.0.1 --output /usr/bin/caddy',
    '# RUN xcaddy build v2.11.4 --with github.com/caddy-dns/hetzner/v2@v2.0.1 --output /usr/bin/caddy'
  );
  assert.ok(hasProblem(pinProblems(commented), 'exactly one xcaddy build'));
});

test('a coherent deliberate bump passes the static check but not against the old binary', () => {
  const bumped = swap(DOCKERFILE, '@v2.0.1', '@v2.0.2');
  assert.deepEqual(pinProblems(bumped), []);
  const found = compareReports(readPins(bumped), OBSERVED);
  assert.ok(
    hasProblem(found, 'binary has dns.providers.hetzner v2.0.1, the Dockerfile pins v2.0.2')
  );
  assert.ok(hasProblem(found, 'build-info has github.com/caddy-dns/hetzner/v2 v2.0.1'));
});

test('the binary check reports each way the built image can differ from the pins', () => {
  const pins = readPins(DOCKERFILE);
  const cases = [
    [{ version: 'v2.11.3 h1:abc\n' }, 'binary reports Caddy v2.11.3'],
    [{ version: '' }, 'binary reports Caddy'],
    [
      { modules: OBSERVED.modules.replace('dns.providers.hetzner v2.0.1\n', '') },
      'no dns.providers.hetzner module',
    ],
    [
      { modules: OBSERVED.modules.replace('hetzner v2.0.1', 'hetzner v2.0.0') },
      'binary has dns.providers.hetzner v2.0.0',
    ],
    [
      { modules: OBSERVED.modules.replace('dns.providers.hetzner', 'dns.providers.hetzner_x') },
      'no dns.providers.hetzner module',
    ],
    [
      { buildInfo: OBSERVED.buildInfo.replace('hetzner/v2\tv2.0.1', 'hetzner/v2\tv2.0.0') },
      'build-info has github.com/caddy-dns/hetzner/v2 v2.0.0',
    ],
    [
      { buildInfo: OBSERVED.buildInfo.replace(/^dep\tgithub.com\/caddy-dns.*\n/m, '') },
      'hetzner/v2 absent',
    ],
    [
      { buildInfo: OBSERVED.buildInfo.replace('caddy/v2\tv2.11.4', 'caddy/v2\tv2.11.3') },
      'build-info has github.com/caddyserver/caddy/v2 v2.11.3',
    ],
    [{ arch: 'arm64' }, "image architecture is 'arm64'"],
    [{ arch: undefined }, 'image architecture'],
  ];
  for (const [change, expected] of cases) {
    const found = compareReports(pins, { ...OBSERVED, ...change });
    assert.ok(hasProblem(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
  assert.deepEqual(compareReports(pins, { ...OBSERVED, arch: 'arm64' }, 'arm64'), []);
  assert.deepEqual(compareReports({ froms: [], builds: [], modules: [] }, OBSERVED), [
    'the Dockerfile pins cannot be read',
  ]);
});

test('the workflow checker reports each way the publish workflow can go wrong', () => {
  const [beforePull, pullJob] = WORKFLOW.split('\n  anonymous-pull:\n');
  const inPull = (from, to) => `${beforePull}\n  anonymous-pull:\n${swap(pullJob, from, to)}`;
  const inPush = (from, to) => `${swap(beforePull, from, to)}\n  anonymous-pull:\n${pullJob}`;
  const widened = "(github.event_name != 'x')";
  const guardTail = "(github.event_name == 'workflow_dispatch' || github.event_name == 'push')";
  const cases = [
    // The push job.
    [inPush(guardTail, widened), 'exactly the main-only'],
    [
      inPush("github.ref == 'refs/heads/main' &&\n      (", 'always() ||\n      ('),
      'exactly the main-only',
    ],
    [inPush('    needs: build\n', ''), 'does not wait on the proof job'],
    [inPush('needs.build.outputs.image-id', 'needs.build.outputs.other'), 'image ID'],
    [inPush('docker load --input demo-edge.tar', 'true'), 'does not load the proven image'],
    [inPush("grep -Eq '^sha256:[0-9a-f]{64}$'", "grep -Eq '.*'"), 'malformed digest'],
    [
      inPush(
        '      - name: Push\n',
        '      - name: Rebuild\n        run: docker build --tag "$IMAGE:$IMAGE_TAG" services/demo-edge\n\n      - name: Push\n'
      ),
      'rebuilds',
    ],
    [
      inPush(
        '      - name: Push\n',
        '      - name: Tag\n        run: docker tag demo-edge:ci "$IMAGE:latest"\n\n      - name: Push\n'
      ),
      'latest',
    ],
    [inPush('IMAGE_TAG: ${{ github.sha }}', 'IMAGE_TAG: stable'), 'commit SHA'],
    [inPush('docker push "$IMAGE:$IMAGE_TAG"', 'true'), 'never pushes'],
    [inPush('Pin this:', 'Pinned:'), 'lacks "Pin this:"'],
    [inPush('      packages: write\n', '      packages: read\n'), 'lacks packages: write'],
    [
      inPush(
        '      - name: Attest and verify the pushed image\n        uses: branchLeft/github-workflows/.github/actions/attest-and-verify-image@77506b6d4603ef432bbdec734139fec91e5bea47 # v1.1.0\n',
        '      - name: Attest and verify the pushed image\n        run: true\n'
      ),
      'shared attest and verify action',
    ],
    [inPush('    needs: [push, scan]\n', '    needs: [push]\n'), 'wait on the push and the scan'],
    [inPush('      id-token: write\n', ''), 'not on the attest job alone'],
    // The attestation identity.
    [
      swap(
        WORKFLOW,
        'signer-workflow: branchLeft/ghost-platform/.github/workflows/demo-edge-image.yml',
        'signer-workflow: branchLeft/ghost-platform/.github/workflows/portal-apps-image.yml'
      ),
      'signer-workflow is not the literal',
    ],
    [
      swap(
        WORKFLOW,
        'signer-workflow: branchLeft/ghost-platform/.github/workflows/demo-edge-image.yml',
        'signer-workflow: ${{ github.workflow_ref }}'
      ),
      'signer-workflow is not the literal',
    ],
    // Scopes.
    [
      swap(
        WORKFLOW,
        'permissions:\n  contents: read\n\n',
        'permissions:\n  contents: read\n  packages: write\n\n'
      ),
      'top-level',
    ],
    [
      swap(
        WORKFLOW,
        'permissions:\n  contents: read\n\n',
        'permissions:\n  contents: read\n  id-token: write\n\n'
      ),
      'not on the attest job alone',
    ],
    [
      swap(
        WORKFLOW,
        '    timeout-minutes: 20\n\n    outputs:\n      image-id',
        '    timeout-minutes: 20\n\n    permissions:\n      id-token: write\n\n    outputs:\n      image-id'
      ),
      'only push and attest may',
    ],
    // The build job.
    [swap(WORKFLOW, '--platform linux/amd64 \\\n', ''), '--platform linux/amd64'],
    [
      swap(WORKFLOW, 'run: node scripts/demo-edge-pins.mjs demo-edge:ci\n', 'run: "true"\n'),
      'Dockerfile pins',
    ],
    [swap(WORKFLOW, 'is vacuous', 'is fine'), 'drifted pin is refused'],
    [
      swap(WORKFLOW, 'run: node --test workflow-demo-edge-image.test.js', 'run: "true"'),
      'workflow and pins tests',
    ],
    [
      swap(WORKFLOW, 'echo "image-id=$(docker image inspect', 'echo "id=$(docker image inspect'),
      'save the proven image',
    ],
    // The anonymous pull.
    [`${beforePull}\n`, 'no anonymous-pull job'],
    [inPull('    needs: [push, attest]\n', ''), 'does not wait on push and attest'],
    [inPull(guardTail, widened), 'exactly the main-only'],
    [
      inPull('      contents: read\n', '      contents: read\n      packages: write\n'),
      'only push and attest may',
    ],
    [
      inPull('      contents: read\n', '      contents: read\n      packages: read\n'),
      'permissions are not exactly',
    ],
    [
      inPull(
        '      - name: Pull the digest anonymously\n',
        '      - name: Log in\n        uses: docker/login-action@81c6f93d4bc991e510b342a00b419b3bb4efc5c6\n        with:\n          registry: ghcr.io\n          password: ${{ secrets.GITHUB_TOKEN }}\n\n      - name: Pull the digest anonymously\n'
      ),
      'logs in',
    ],
    [
      inPull('docker pull --platform linux/amd64 "$PINNED_IMAGE"', 'docker pull "$PINNED_IMAGE"'),
      'does not pull the pinned digest',
    ],
    [
      inPull('${{ needs.push.outputs.image }}', 'ghcr.io/branchleft/demo-edge:latest'),
      'does not take the digest',
    ],
    [
      inPull('run: node scripts/demo-edge-pins.mjs "$PINNED_IMAGE"', 'run: "true"'),
      'pulled binary',
    ],
  ];
  for (const [text, expected] of cases) {
    const found = demoEdgeProblems(text);
    assert.ok(hasProblem(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

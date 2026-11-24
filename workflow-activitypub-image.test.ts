// The activitypub images are the upstream ActivityPub service and its migrate
// image, built from one pinned upstream commit. A slip in how they are built or
// published is silent: an unpinned source, a build that is not the production
// target, a licence that does not ship, a push that rebuilds, an image that is
// signed before its scan, or a missing register name. These checks read the
// pin, the licence overlay and the publish workflow as text, and name each way
// they can drift. Each case breaks one property in a copy of the real text and
// requires a named problem, so a passing run means the check can see the break.
// Read as text, like the other workflow tests here, because the repo's test job
// installs no YAML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'activitypub-image.yml');
const PIN = path.join(ROOT, 'services', 'activitypub', 'UPSTREAM');
const OVERLAY = path.join(ROOT, 'services', 'activitypub', 'licence.Dockerfile');
const LICENCE = path.join(ROOT, 'services', 'activitypub', 'LICENSE');
const REGISTER = path.join(ROOT, 'registers', 'packages.json');

const IMAGE_SCAN =
  'branchLeft/github-workflows/.github/workflows/image-scan.yml@f559ca696956d3d58440f56666d85f36c829c08b';
const ATTEST =
  'branchLeft/github-workflows/.github/actions/attest-and-verify-image@f559ca696956d3d58440f56666d85f36c829c08b';
const SIGNER = 'branchLeft/ghost-platform/.github/workflows/activitypub-image.yml';
const GUARD =
  "github.ref == 'refs/heads/main' &&\n      (github.event_name == 'workflow_dispatch' || github.event_name == 'push')";

// Whole-line comments go, so text inside a comment can never satisfy a check.
export const withoutComments = (text) => text.replace(/^[ \t]*#.*$/gm, '');

// The text of one job: from its `  name:` line to the next job or the end.
export function jobText(text, name) {
  const jobs = text.slice(text.indexOf('\njobs:') + 1);
  const start = jobs.search(new RegExp(`^  ${name}:\\n`, 'm'));
  if (start === -1) return '';
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\n/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

// The lines of every `run:` body. A `${{ }}` inside one is refused (CI-2).
export function runBodies(text) {
  const lines = text.split('\n');
  const bodies = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)run:/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') {
        body.push(l);
        continue;
      }
      if (l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    bodies.push(body.join('\n'));
  });
  return bodies;
}

const pinned = (text) => /^commit=([0-9a-f]{40})$/m.exec(text)?.[1] ?? null;

export function problems(workflow) {
  const found = [];
  const text = withoutComments(workflow);
  const top = text.split(/^jobs:\n/m)[0];
  if (/^\s*(\w+):\s*write(-all)?\s*$/m.test(top)) {
    found.push('top-level permissions grant a write scope');
  }
  const jobs = [
    'build',
    'push',
    'scan-service',
    'scan-migrate',
    'attest-service',
    'attest-migrate',
  ];
  for (const name of jobs) {
    if (!jobText(text, name)) found.push(`job ${name} is missing`);
  }
  if (found.length) return found;

  // Build: the pin, fetched and checked, then the upstream production target and
  // the migrate Dockerfile, each with the licence overlay.
  const build = jobText(text, 'build');
  if (!/commit=\/\^\[0-9a-f\]\{40\}/.test(build) && !/\[0-9a-f\]\{40\}/.test(build)) {
    found.push('the build does not check the pin is a full 40-digit SHA');
  }
  if (!/ref: \$\{\{ steps\.pin\.outputs\.commit \}\}/.test(build)) {
    found.push('the upstream source is not fetched at the pinned commit');
  }
  if (!/repository: TryGhost\/ActivityPub/.test(build)) {
    found.push('the upstream source is not the TryGhost/ActivityPub repository');
  }
  if (!/rev-parse HEAD\)" = "\$PINNED"/.test(build)) {
    found.push('the build does not check the source is the pinned commit');
  }
  if (!/docker build [^\n]*--target production [^\n]*upstream\n/.test(build)) {
    found.push('the service is not the upstream production target');
  }
  if (!/docker build [^\n]*upstream\/migrate\n/.test(build)) {
    found.push('the migrate image is not built from upstream migrate/');
  }
  if (
    !/--file services\/activitypub\/licence\.Dockerfile --build-arg UPSTREAM_IMAGE=activitypub-upstream:ci/.test(
      build
    )
  ) {
    found.push('the service does not get the upstream licence');
  }
  if (
    !/--file services\/activitypub\/licence\.Dockerfile --build-arg UPSTREAM_IMAGE=activitypub-migrate-upstream:ci/.test(
      build
    )
  ) {
    found.push('the migrate image does not get the upstream licence');
  }
  if (!/--platform linux\/amd64/.test(build))
    found.push('the images are not built for linux/amd64');
  if (!/--entrypoint node activitypub:ci --version \| grep -qx 'v26\.13\.1'/.test(build)) {
    found.push('the proof does not check the pinned Node runtime');
  }
  if (!/--entrypoint migrate activitypub-migrate:ci -version/.test(build))
    found.push('the proof does not run the migrate tool');
  if (
    !/docker save --output activitypub\.tar/.test(build) ||
    !/service-id=.*docker image inspect/.test(build)
  ) {
    found.push('the proof does not save the service image and output its ID');
  }
  if (
    !/docker save --output activitypub-migrate\.tar/.test(build) ||
    !/migrate-id=.*docker image inspect/.test(build)
  ) {
    found.push('the proof does not save the migrate image and output its ID');
  }

  // Push: main only, after the proof, loads exactly the proven images, never
  // rebuilds, pushes both, and refuses a malformed digest.
  const push = jobText(text, 'push');
  if (!/^ {4}needs: build$/m.test(push)) found.push('push does not wait on the proof job');
  if (
    !/^ {4}if: \|\n {6}github\.ref == 'refs\/heads\/main' &&\n {6}\(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'push'\)/m.test(
      push
    )
  ) {
    found.push('push has no job-level guard that is exactly the main-only expression');
  }
  if (!/packages: write/.test(push)) found.push('push lacks packages: write');
  if (
    !/docker push "\$SERVICE_IMAGE:\$IMAGE_TAG"/.test(push) ||
    !/docker push "\$MIGRATE_IMAGE:\$IMAGE_TAG"/.test(push)
  ) {
    found.push('push does not push both images');
  }
  if (
    !/docker load --input activitypub\.tar/.test(push) ||
    !/docker load --input activitypub-migrate\.tar/.test(push)
  ) {
    found.push('push does not load both proven images');
  }
  if (
    !/needs\.build\.outputs\.service-id/.test(push) ||
    !/needs\.build\.outputs\.migrate-id/.test(push)
  ) {
    found.push('push does not check both proven image IDs');
  }
  if (!/\^sha256:\[0-9a-f\]\{64\}\$/.test(push) || !/exit 1/.test(push)) {
    found.push('push does not refuse a malformed digest');
  }
  if (/:latest/.test(push)) found.push('push tags latest');

  // Scan and attest: each image is scanned, and signed only after its scan.
  for (const [name, image, digestOutput] of [
    ['service', 'service-image', 'service-digest'],
    ['migrate', 'migrate-image', 'migrate-digest'],
  ]) {
    const scan = jobText(text, `scan-${name}`);
    if (!scan.includes(`uses: ${IMAGE_SCAN}`))
      found.push(`scan-${name} is not the shared image scan`);
    if (!scan.includes(`image: \${{ needs.push.outputs.${image} }}`)) {
      found.push(`scan-${name} does not scan the pushed ${name} image`);
    }
    const attest = jobText(text, `attest-${name}`);
    if (!new RegExp(`needs: \\[push, scan-${name}\\]`).test(attest)) {
      found.push(`attest-${name} does not wait on its scan`);
    }
    if (!attest.includes(`uses: ${ATTEST}`))
      found.push(`attest-${name} is not the shared attest action`);
    if (!attest.includes(`digest: \${{ needs.push.outputs.${digestOutput} }}`)) {
      found.push(`attest-${name} does not attest the pushed digest`);
    }
    if (!attest.includes(`signer-workflow: ${SIGNER}`)) {
      found.push(`attest-${name} does not name this workflow as the signer`);
    }
  }
  if (!/ghcr\.io\/branchleft\/activitypub-migrate/.test(text)) {
    found.push('the migrate image is not published as its own package');
  }

  // CI-2: no expression is expanded into a run body.
  for (const body of runBodies(text)) {
    if (body.includes('${{')) found.push('an expression is interpolated into a run: body');
  }
  return found;
}

const real = fs.readFileSync(WORKFLOW, 'utf8');

test('the workflow proves, pushes, scans and attests both images with no problem', () => {
  assert.deepEqual(problems(real), []);
});

test('the pin is a full commit SHA of the upstream service', () => {
  const pin = fs.readFileSync(PIN, 'utf8');
  assert.match(pin, /^repository=TryGhost\/ActivityPub$/m);
  assert.ok(pinned(pin), 'the pin file holds a 40-digit commit');
});

test('the upstream licence ships in each image through the overlay', () => {
  const licence = fs.readFileSync(LICENCE, 'utf8');
  assert.match(licence, /^MIT License/);
  const overlay = fs.readFileSync(OVERLAY, 'utf8');
  assert.match(overlay, /^FROM \$\{UPSTREAM_IMAGE\}$/m);
  assert.match(overlay, /^COPY LICENSE \/licenses\/LICENSE$/m);
  assert.doesNotMatch(overlay, /^(USER|ENTRYPOINT|CMD|ENV)\b/m, 'the overlay changes nothing else');
});

test('the publish package names are on the register as public', () => {
  const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
  for (const name of ['activitypub', 'activitypub-migrate']) {
    const entry = register.packages.find((p) => p.name === name);
    assert.ok(entry, `${name} is on the register`);
    assert.equal(entry.visibility, 'public');
  }
});

test('the checker reports each way the workflow can drift', () => {
  const cases = [
    [
      real.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      'top-level permissions grant a write scope',
    ],
    [real.replace('    needs: build\n', ''), 'does not wait on the proof job'],
    [
      real.replace(
        'digest: ${{ needs.push.outputs.migrate-digest }}',
        'digest: ${{ needs.push.outputs.service-digest }}'
      ),
      'does not attest the pushed digest',
    ],
    [
      real.replace('    needs: [push, scan-service]', '    needs: [push]'),
      'does not wait on its scan',
    ],
    [
      real.replace(
        /uses: branchLeft\/github-workflows\/\.github\/workflows\/image-scan\.yml@\S+ # v1\.2\.7\n    with:\n      image: \$\{\{ needs\.push\.outputs\.migrate-image \}\}/,
        'run: echo none'
      ),
      'does not scan the pushed migrate image',
    ],
    [real.replace('--target production', ''), 'not the upstream production target'],
    [
      real.replace('ref: ${{ steps.pin.outputs.commit }}', 'ref: main'),
      'not fetched at the pinned commit',
    ],
    [
      real.replace(
        '--file services/activitypub/licence.Dockerfile --build-arg UPSTREAM_IMAGE=activitypub-migrate-upstream:ci',
        '--build-arg UPSTREAM_IMAGE=activitypub-migrate-upstream:ci'
      ),
      'the migrate image does not get the upstream licence',
    ],
    [
      real.replace('          docker push "$MIGRATE_IMAGE:$IMAGE_TAG"\n', ''),
      'push does not push both images',
    ],
    [
      real.replace(
        '      SERVICE_ID: ${{ needs.build.outputs.service-id }}',
        '      SERVICE_ID: ${{ needs.build.outputs.image-id }}'
      ),
      'does not check both proven image IDs',
    ],
    [
      real.replace(
        'run: |\n          set -eu\n          docker load',
        'run: |\n          set -eu\n          echo ${{ github.head_ref }}\n          docker load'
      ),
      'an expression is interpolated into a run: body',
    ],
  ];
  for (const [text, expected] of cases) {
    assert.notEqual(text, real, `the sabotage changed the text for: ${expected}`);
    const found = problems(text);
    assert.ok(
      found.some((p) => p.includes(expected)),
      `expected "${expected}", got ${JSON.stringify(found)}`
    );
  }
});

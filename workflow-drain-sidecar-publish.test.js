import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The sidecar is delivered to the host by digest only, so the publish job's
// shape is a control: it must follow the proof, run only from main, hold the
// write credential alone, publish the image the proof tested without
// rebuilding it, and refuse to finish without a verified digest.
const FILE = path.join(import.meta.dirname, '.github', 'workflows', 'drain-sidecar-image.yml');
const DOCKERFILE = path.join(import.meta.dirname, 'services', 'drain-sidecar', 'Dockerfile');

// Whole-line comments and trailing ones (a `#` after whitespace) both go, so
// text inside a comment can never satisfy a check.
const withoutComments = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');

const GUARD =
  "github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.event_name == 'push')";
const normalise = (condition) =>
  condition
    .replace(/^\s*if:\s*\|?-?/, '')
    .replace(/\s+/g, ' ')
    .trim();

// A job is the block under `jobs:` at two spaces of indent. Its own keys sit
// at four spaces, so a step-level `if:` (eight or more) is never mistaken for
// the job's own.
export function parseJobs(source, strip = true) {
  const lines = (strip ? withoutComments(source) : source).split('\n');
  const jobs = {};
  let current = null;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const header = /^ {2}([a-z][a-z-]*):\s*$/.exec(line);
    if (header) {
      current = { lines: [], condition: '' };
      jobs[header[1]] = current;
    } else if (current) {
      current.lines.push(line);
    }
  }
  for (const job of Object.values(jobs)) {
    job.text = job.lines.join('\n');
    const at = job.lines.findIndex((l) => /^ {4}if:/.test(l));
    if (at >= 0) {
      const rest = job.lines.slice(at + 1);
      const end = rest.findIndex((l) => /^ {4}\S/.test(l));
      job.condition = [job.lines[at], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
    }
  }
  return jobs;
}

export function problems(source) {
  const found = [];
  const { build, push } = parseJobs(source);
  if (!build || !push) return ['build and push jobs both exist'];
  const top = withoutComments(source).split(/^jobs:\n/m)[0];
  const grantsWrite = /:\s*write(-all)?\s*$|^\s*permissions:\s*write-all/m;
  if (grantsWrite.test(top)) found.push('top-level permissions grant a write scope');
  for (const [name, job] of Object.entries(parseJobs(source))) {
    if (name !== 'push' && grantsWrite.test(job.text)) {
      found.push(`job ${name} holds a write permission; only push may`);
    }
  }
  if (!/packages:\s*write/.test(push.text)) found.push('push job lacks packages: write');
  if (!/^ {4}needs: build$/m.test(push.text)) found.push('push job does not wait on the proof job');
  if (normalise(push.condition) !== GUARD) {
    found.push('push job has no job-level guard that is exactly the main-only expression');
  }
  if (!/docker push "\$IMAGE:\$IMAGE_TAG"/.test(push.text)) found.push('push job never pushes');
  // Scanned unstripped: a `#` inside a `run: |` body is shell text, not a
  // YAML comment, and must not be able to hide a build behind it.
  const rawPush = parseJobs(source, false).push.text;
  if (/\bdocker\b[^\n]*\bbuild\b|build-push-action/.test(rawPush)) {
    found.push('push job rebuilds the image instead of publishing the proven one');
  }
  if (!/needs\.build\.outputs\.image-id/.test(push.text)) {
    found.push("push job does not consume the proof job's image ID");
  }
  if (!/docker load\b/.test(push.text)) found.push('push job does not load the proven image');
  if (!/image-id=.*docker image inspect/.test(build.text) || !/docker save\b/.test(build.text)) {
    found.push('proof job does not save the proven image and output its ID');
  }
  if (!/\^sha256:\[0-9a-f\]\{64\}\$/.test(push.text) || !/exit 1/.test(push.text)) {
    found.push('push job does not refuse a malformed digest');
  }
  if (!/image: \$\{\{ steps\.digest\.outputs\.image \}\}/.test(push.text)) {
    found.push('push job does not output the pinned reference');
  }
  if (/:latest/.test(push.text)) found.push('push job tags latest');
  return found;
}

test('the sidecar publish job is gated, scoped, digest-verified and does not rebuild', () => {
  assert.deepEqual(problems(fs.readFileSync(FILE, 'utf8')), []);
});

test('the sidecar base image is pinned by digest as well as tag', () => {
  assert.match(fs.readFileSync(DOCKERFILE, 'utf8'), /^FROM node:[\w.-]+@sha256:[0-9a-f]{64}$/m);
});

test('the checker still reports each way the publish job can go wrong', () => {
  const good = fs.readFileSync(FILE, 'utf8');
  const guard = /^ {4}if: \|\n(?: {6}.*\n)+/m;
  const stepOnly = good
    .replace(guard, '')
    .replace(
      '      - name: Push\n',
      "      - name: Push\n        if: github.ref == 'refs/heads/main'\n"
    );
  const rebuilds = good.replace(
    '      - name: Push\n',
    '      - name: Rebuild\n        run: docker build --tag "$IMAGE:$IMAGE_TAG" services/drain-sidecar\n\n      - name: Push\n'
  );
  const withGuard = (expression) => good.replace(guard, `    if: ${expression}\n`);
  const rebuildWith = (step) =>
    good.replace('      - name: Push\n', `      - name: Rebuild\n${step}\n\n      - name: Push\n`);
  const cases = [
    [withGuard("always() # github.ref == 'refs/heads/main'"), 'exactly the main-only'],
    [withGuard(`${GUARD} || true`), 'exactly the main-only'],
    [withGuard('always()'), 'exactly the main-only'],
    [
      rebuildWith('        run: echo " #"; docker build --tag x services/drain-sidecar'),
      'rebuilds',
    ],
    [
      good.replace(
        '    timeout-minutes: 15\n',
        '    timeout-minutes: 15\n    permissions:\n      id-token: write\n'
      ),
      'only push may',
    ],
    [rebuildWith('        run: docker image build --tag x services/drain-sidecar'), 'rebuilds'],
    [rebuildWith('        run: docker buildx build --tag x services/drain-sidecar'), 'rebuilds'],
    [rebuildWith('        uses: docker/build-push-action@v6'), 'rebuilds'],
    [good.replace('    needs: build\n', ''), 'does not wait'],
    [good.replace(guard, ''), 'job-level guard'],
    [stepOnly, 'job-level guard'],
    [rebuilds, 'rebuilds'],
    [good.replace('needs.build.outputs.image-id', 'needs.build.outputs.other'), 'image ID'],
    [good.replace('  contents: read\n  packages: read\n', '  packages: write\n'), 'top-level'],
    [good.split('exit 1').join('true'), 'malformed digest'],
    [good.replace('docker push "$IMAGE:$IMAGE_TAG"', 'true'), 'never pushes'],
  ];
  for (const [text, expected] of cases) {
    assert.ok(
      problems(text).some((p) => p.includes(expected)),
      `expected a problem containing "${expected}"`
    );
  }
});

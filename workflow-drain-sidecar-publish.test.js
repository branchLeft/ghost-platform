import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GUARD, problems } from './test-support/publish-job-checks.mjs';

// The sidecar is delivered to the host by digest only, so the publish job's
// shape is a control: it must follow the proof, run only from main, hold the
// write credential alone, publish the image the proof tested without
// rebuilding it, and refuse to finish without a verified digest.
const FILE = path.join(import.meta.dirname, '.github', 'workflows', 'drain-sidecar-image.yml');
const DOCKERFILE = path.join(import.meta.dirname, 'services', 'drain-sidecar', 'Dockerfile');

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

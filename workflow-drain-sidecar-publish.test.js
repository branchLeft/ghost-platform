import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The sidecar is delivered to the host by digest only, so the publish job's
// shape is a control: it must follow the proof, run only from main, hold the
// write credential alone, and refuse to finish without a verified digest.
const FILE = path.join(import.meta.dirname, '.github', 'workflows', 'drain-sidecar-image.yml');

export function jobs(text) {
  const body = text.split(/^jobs:\n/m)[1] ?? '';
  const out = {};
  const parts = body.split(/^ {2}(?=[a-z][a-z-]*:\n)/m).filter(Boolean);
  for (const part of parts) out[part.split(':')[0]] = part;
  return out;
}

export function problems(source) {
  const text = source.replace(/^\s*#.*$/gm, '');
  const found = [];
  const { build, push } = jobs(text);
  if (!build || !push) return ['build and push jobs both exist'];
  const top = text.split(/^jobs:\n/m)[0];
  if (/packages:\s*write/.test(top)) found.push('top-level permissions grant packages: write');
  if (/packages:\s*write/.test(build)) found.push('proof job holds packages: write');
  if (!/packages:\s*write/.test(push)) found.push('push job lacks packages: write');
  if (!/^ {4}needs: build$/m.test(push)) found.push('push job does not wait on the proof job');
  if (!/github\.ref == 'refs\/heads\/main'/.test(push))
    found.push('push job is not limited to main');
  if (!/docker push "\$IMAGE:\$IMAGE_TAG"/.test(push)) found.push('push job never pushes');
  if (!/\^sha256:\[0-9a-f\]\{64\}\$/.test(push) || !/exit 1/.test(push)) {
    found.push('push job does not refuse a malformed digest');
  }
  if (!/image: \$\{\{ steps\.digest\.outputs\.image \}\}/.test(push)) {
    found.push('push job does not output the pinned reference');
  }
  if (/:latest|--tag "?\$IMAGE"?\s/.test(push)) found.push('push job tags latest');
  return found;
}

test('the sidecar publish job is gated, scoped and digest-verified', () => {
  assert.deepEqual(problems(fs.readFileSync(FILE, 'utf8')), []);
});

test('the checker still reports each way the publish job can go wrong', () => {
  const good = fs.readFileSync(FILE, 'utf8');
  const cases = [
    [good.replace('    needs: build\n', ''), 'does not wait'],
    [good.replace("github.ref == 'refs/heads/main'", 'true'), 'not limited to main'],
    [good.replace('  contents: read\n  packages: read\n', '  packages: write\n'), 'top-level'],
    [good.replace('exit 1', 'true'), 'malformed digest'],
    [good.replace('docker push "$IMAGE:$IMAGE_TAG"', 'true'), 'never pushes'],
  ];
  for (const [text, expected] of cases) {
    assert.ok(
      problems(text).some((p) => p.includes(expected)),
      `expected a problem containing "${expected}"`
    );
  }
});

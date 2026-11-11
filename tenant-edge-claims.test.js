// Pins the corrected tenant-edge prose: the MiB rationale and the edge-limit
// wording in infra/tenant, and runbook section 9. Each assertion names a claim
// that was false and what replaced it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('runtime.ts does not claim the edge limit rejects before the app host is reached', () => {
  assert.ok(!read('infra/tenant/runtime.ts').includes('before it reaches an app host'));
});

test('the tenant README keeps the MiB reason at 4.6% and drops the 4.4% figure', () => {
  const text = read('infra/tenant/README.md');
  assert.ok(text.includes('about 4.6% smaller'));
  assert.ok(!text.includes('4.4%'));
});

test('the tenant README no longer says the edge registry has no field for the value', () => {
  const text = read('infra/tenant/README.md');
  assert.ok(!text.includes('nothing yet carries it'));
  assert.ok(text.includes('requestBodyMaxSize'));
});

test('runbook section 9 names the field and the hand-delivery and reload caveat', () => {
  const text = read('RUNBOOK-tenant-onboarding.md');
  const start = text.indexOf('### 9. Register the tenant at the edge');
  const end = text.indexOf('### 10.', start);
  assert.ok(start >= 0 && end > start, 'section 9 not found');
  const section = text.slice(start, end);
  assert.ok(section.includes('requestBodyMaxSize'), 'field name missing');
  assert.ok(section.includes('hetzner/edge/stack/**'), 'hand-delivery path missing');
  assert.ok(section.includes('silent no-op'), 'restart caveat missing');
  assert.ok(section.includes('reload Caddy in place'), 'reload instruction missing');
});

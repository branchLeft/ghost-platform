// node --test csp/proof/setup-paid.test.mjs -- the one rule that matters here:
// a live Stripe key can never reach a Ghost this proof configures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertTestKeys } from './setup-paid.mjs';

// Shaped like live keys but short and assembled at run time, so no secret
// scanner (or grep for a live-key prefix) trips on this file.
const LIVE_SECRET = ['sk', 'live', 'abc123XYZ'].join('_');
const LIVE_PUBLISHABLE = ['pk', 'live', 'abc123XYZ'].join('_');

test('accepts synthetic test-mode keys', () => {
  assert.doesNotThrow(() => assertTestKeys('sk_test_abc123XYZ', 'pk_test_abc123XYZ'));
});

test('control: a live secret key is refused', () => {
  assert.throws(() => assertTestKeys(LIVE_SECRET, 'pk_test_abc123XYZ'), /sk_test_/);
});

test('a live publishable key is refused', () => {
  assert.throws(() => assertTestKeys('sk_test_abc123XYZ', LIVE_PUBLISHABLE), /pk_test_/);
});

test('an empty or restricted-key value is refused', () => {
  assert.throws(() => assertTestKeys('', ''), /sk_test_/);
  assert.throws(() => assertTestKeys('rk_test_abc', 'pk_test_abc'), /sk_test_/);
});

// The script refuses before it makes a single request: no Ghost is running
// at the (unroutable) origin, so any request would surface as a network error
// instead of the refusal.
test('the CLI refuses a live key before contacting Ghost', () => {
  const cli = fileURLToPath(new URL('./setup-paid.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_ORIGIN: 'http://127.0.0.1:9',
      PROOF_SESSION_COOKIE: 'x=y',
      PROOF_STRIPE_SECRET_KEY: LIVE_SECRET,
      PROOF_STRIPE_PUBLISHABLE_KEY: LIVE_PUBLISHABLE,
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing: the Stripe secret key must be a sk_test_ key/);
});

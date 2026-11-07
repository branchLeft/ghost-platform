// Tests for the checkout verdict. The fixtures are the shapes
// csp/proof/capture-checkout.mjs printed in the live runs this gate was built
// from: a clean paid flow (the policy with the measured Stripe origins) and the
// control (the same flow under a policy without them).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judgeCheckout } from './checkout-gate.mjs';

const STEPS = [
  'signed-up',
  'magic-link-received',
  'magic-link-followed',
  'member-session',
  'checkout-opened',
  'returned-from-checkout',
  'paid',
];
const green = {
  label: 'checkout',
  realStripeJs: false,
  steps: STEPS,
  violations: [],
  magicLinkFollowed: true,
  memberSession: true,
  checkoutOpened: true,
  returnedFromCheckout: true,
  paid: true,
  stripeJsLoaded: true,
  failedAt: null,
  error: null,
};
const STRIPE_BLOCKED = {
  directive: 'script-src-elem',
  blockedURI: 'https://js.stripe.com/v3/',
  disposition: 'enforce',
  documentURI: 'http://localhost:4321/',
  frame: 'http://localhost:4321/',
};

test('a complete paid flow with no violation in any frame passes', () => {
  assert.deepEqual(judgeCheckout(green), []);
});

// The control case: the same flow under a policy without the Stripe source.
// The functional flow still completes (Ghost redirects to checkout without
// Stripe.js), so only the violation tells the policy is wrong -- the verdict
// must name the directive and the origin.
test('control: a policy missing the Stripe source is red and names the directive and origin', () => {
  const f = judgeCheckout({ ...green, stripeJsLoaded: false, violations: [STRIPE_BLOCKED] });
  assert.ok(
    f.some((m) => m.includes('script-src-elem https://js.stripe.com/v3/')),
    f.join('\n')
  );
});

test('red on a single violation in any frame, even with the whole flow completing', () => {
  const portalFrame = {
    ...STRIPE_BLOCKED,
    frame: 'about:srcdoc',
    directive: 'frame-src',
    blockedURI: 'https://js.stripe.com',
  };
  const f = judgeCheckout({ ...green, violations: [portalFrame] });
  assert.equal(f.length, 1);
  assert.match(f[0], /1 violation\(s\) across all frames/);
});

test('red when the magic link was not followed', () => {
  assert.deepEqual(judgeCheckout({ ...green, magicLinkFollowed: false }), [
    'the magic link was not followed',
  ]);
});

test('red when Ghost served no member session', () => {
  assert.deepEqual(judgeCheckout({ ...green, memberSession: false }), [
    'Ghost did not serve a member session after the magic link',
  ]);
});

test('red when checkout did not open', () => {
  assert.deepEqual(judgeCheckout({ ...green, checkoutOpened: false }), ['checkout did not open']);
});

test('red when the visitor did not come back from checkout', () => {
  assert.deepEqual(judgeCheckout({ ...green, returnedFromCheckout: false }), [
    'the visitor did not come back from checkout',
  ]);
});

test('red when the member is not paid, and when paid was never checked', () => {
  assert.deepEqual(judgeCheckout({ ...green, paid: false }), ['the member did not become paid']);
  assert.deepEqual(judgeCheckout({ ...green, paid: null }), ['the paid state was not checked']);
});

// A clean violation report from a page that never asked for Stripe proves
// nothing about the Stripe origins.
test('red when Stripe.js never loaded, so a clean report is not evidence', () => {
  const f = judgeCheckout({ ...green, stripeJsLoaded: false });
  assert.equal(f.length, 1);
  assert.match(f[0], /Stripe\.js never loaded/);
});

test('red when the flow stopped partway, naming where and why', () => {
  const f = judgeCheckout({
    ...green,
    failedAt: 'after member-session',
    error: 'locator.waitFor: Timeout 15000ms exceeded.',
    checkoutOpened: false,
    returnedFromCheckout: false,
    paid: null,
  });
  assert.ok(f[0].includes('the flow stopped (after member-session): locator.waitFor'), f[0]);
});

test('red when the run is malformed (missing fields)', () => {
  assert.ok(judgeCheckout({}).length >= 5);
});

// The CLI is only a verdict if its main block runs: each case sees the
// verdict's own output, not just an exit code.
const CLI = fileURLToPath(new URL('./checkout-gate.mjs', import.meta.url));

function runCli(capture) {
  return spawnSync(process.execPath, [CLI], { input: JSON.stringify(capture), encoding: 'utf8' });
}

test('CLI: a green capture exits 0 and says so', () => {
  const r = runCli(green);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CSP CHECKOUT GATE GREEN/);
});

test('CLI: a capture with a violation exits 1 and says so', () => {
  const r = runCli({ ...green, violations: [STRIPE_BLOCKED] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CSP CHECKOUT GATE RED/);
});

test('misfired guard with a piped capture fails closed: exit 1, not judged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csp checkout gate '));
  try {
    const harness = join(dir, 'force-misfire.mjs');
    writeFileSync(
      harness,
      `process.argv[1] = ${JSON.stringify(join(dir, 'nowhere', 'checkout-gate.mjs'))};\n` +
        `await import(${JSON.stringify(pathToFileURL(CLI).href)});\n`
    );
    const r = spawnSync(process.execPath, [harness], {
      input: JSON.stringify(green),
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /run-as-main guard did not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

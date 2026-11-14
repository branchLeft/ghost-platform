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
  'member-created',
  'sign-in-link-followed',
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
    f.some((m) => /script-src-elem https:\/\/js\.stripe\.com\/v3\//.test(m)),
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

test('red when Ghost served no member session', () => {
  assert.deepEqual(judgeCheckout({ ...green, memberSession: false }), [
    'Ghost did not serve a member session after the sign-in link',
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
  assert.match(f[0], /the flow stopped \(after member-session\): locator\.waitFor/);
});

test('red when the run is malformed (missing fields)', () => {
  assert.ok(judgeCheckout({}).length >= 4);
});

// Real Stripe TEST-mode (the owner's run): the same flow, but the hosted page is
// Stripe's own, the real Stripe.js loaded, only the published test card was
// typed, and paid is the tenant's own member state. Violations are the tenant's
// (Stripe's page answers to Stripe's policy).
const realGreen = {
  ...green,
  mode: 'real-test-mode',
  realStripeJs: true,
  checkoutHost: 'checkout.stripe.com',
  checkoutSessionIsTest: true,
  cardTyped: '4242 4242 4242 4242',
  paidSource: 'tenant-member-state',
  tenantMemberStatus: 'paid',
  foreignViolations: 3,
};
const REAL = { realMode: true };

test("real mode: a complete paid flow on Stripe's own page with zero tenant violations passes", () => {
  assert.deepEqual(judgeCheckout(realGreen, REAL), []);
});

test('real mode: a capture that is not a real-mode capture is red, and so is the reverse', () => {
  assert.match(judgeCheckout(green, REAL).join('\n'), /not a real test-mode capture/);
  assert.match(judgeCheckout(realGreen).join('\n'), /real test-mode capture judged without/);
});

test('real mode: the stub Stripe.js is red', () => {
  assert.match(
    judgeCheckout({ ...realGreen, realStripeJs: false }, REAL).join('\n'),
    /real Stripe\.js/
  );
});

test("real mode: a checkout page that is not Stripe's own host is red", () => {
  for (const checkoutHost of [
    'localhost',
    'checkout.stripe.com.example.test',
    'stripe.com',
    undefined,
  ]) {
    assert.match(
      judgeCheckout({ ...realGreen, checkoutHost }, REAL).join('\n'),
      /Stripe's own hosted page/,
      String(checkoutHost)
    );
  }
});

test('real mode: a checkout session that is not a test-mode session is red', () => {
  assert.match(
    judgeCheckout({ ...realGreen, checkoutSessionIsTest: false }, REAL).join('\n'),
    /test-mode session/
  );
});

test('real mode: any card but the published test card is red', () => {
  for (const cardTyped of ['4000 0000 0000 0002', undefined, '']) {
    assert.match(
      judgeCheckout({ ...realGreen, cardTyped }, REAL).join('\n'),
      /published test card/,
      String(cardTyped)
    );
  }
});

test("real mode: paid must come from the tenant's own member state", () => {
  assert.match(
    judgeCheckout({ ...realGreen, paidSource: 'fake-state' }, REAL).join('\n'),
    /tenant's own member state/
  );
  assert.match(
    judgeCheckout({ ...realGreen, tenantMemberStatus: 'free' }, REAL).join('\n'),
    /tenant's own member state/
  );
});

test('real mode: the steps must end in paid, all six, in order', () => {
  assert.match(judgeCheckout({ ...realGreen, steps: STEPS.slice(0, 5) }, REAL).join('\n'), /steps/);
  assert.match(
    judgeCheckout({ ...realGreen, steps: [...STEPS].reverse() }, REAL).join('\n'),
    /steps/
  );
});

test("real mode: one tenant-side violation is red even with Stripe's page and a paid member", () => {
  const f = judgeCheckout({ ...realGreen, violations: [STRIPE_BLOCKED] }, REAL);
  assert.equal(f.length, 1);
  assert.match(f[0], /1 violation\(s\) across all frames/);
});

// The CLI is only a verdict if its main block runs: each case sees the
// verdict's own output, not just an exit code.
const CLI = fileURLToPath(new URL('./checkout-gate.mjs', import.meta.url));

function runCli(capture, env = {}) {
  return spawnSync(process.execPath, [CLI], {
    input: JSON.stringify(capture),
    encoding: 'utf8',
    env: { ...process.env, CSP_STRIPE_REAL_TEST_MODE: '', ...env },
  });
}

test('CLI: with the switch set, a real-mode capture exits 0 and says it was real test mode', () => {
  const r = runCli(realGreen, { CSP_STRIPE_REAL_TEST_MODE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /CSP CHECKOUT GATE GREEN \(real Stripe test mode\).*steps=.*,paid violations=0/
  );
});

test('CLI: with the switch set, a fake-Stripe capture is red (the fake is not the real thing)', () => {
  const r = runCli(green, { CSP_STRIPE_REAL_TEST_MODE: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CSP CHECKOUT GATE RED/);
});

test('CLI: without the switch, a real-mode capture is red', () => {
  const r = runCli(realGreen);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CSP CHECKOUT GATE RED/);
});

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

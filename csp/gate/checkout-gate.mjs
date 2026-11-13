// Gate: Stripe checkout under the strict content policy. A real headless
// browser takes a signed-in member through the paid upgrade and the return from
// checkout on a real Ghost behind the edge policy; this module is the verdict on
// what it observed. Observation lives in csp/proof/capture-checkout.mjs; the
// live runner is csp-checkout-gate.py. The magic-link email round trip is NOT
// judged here (it waits on the mail programme): the member signs in through the
// sign-in link Ghost's Admin API issues.
//
// The sibling of csp-regression-gate.mjs (which judges the ATTACK side:
// hostile content must be blocked). This judges the OTHER side: legitimate
// payment traffic must not be. The two are separate because a paid site cannot
// satisfy the regression gate's "exactly one violation" rule while the policy
// lacks Stripe -- Ghost loads js.stripe.com on every page of a paid site.

import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
// Stripe's published success test card: the only one capture-checkout.mjs ever types.
const PUBLISHED_TEST_CARD = '4242 4242 4242 4242';
const REAL_MODE = 'real-test-mode';
const STEPS = [
  'member-created',
  'sign-in-link-followed',
  'member-session',
  'checkout-opened',
  'returned-from-checkout',
  'paid',
];

// What the owner's run against Stripe's own test-mode page must add to the
// fake's rules. Violations are the tenant's only (the capture drops the ones
// Stripe's page raised under Stripe's own policy), and the shared rule below
// counts them.
function judgeRealMode(run) {
  const failures = [];
  if (run.realStripeJs !== true) {
    failures.push('the real Stripe.js did not load (the stub proves nothing about Stripe)');
  }
  if (run.checkoutHost !== 'checkout.stripe.com') {
    failures.push("the visitor never reached Stripe's own hosted page (checkout.stripe.com)");
  }
  if (run.checkoutSessionIsTest !== true) {
    failures.push('the checkout was not a Stripe test-mode session');
  }
  if (run.cardTyped !== PUBLISHED_TEST_CARD) {
    failures.push("the card typed was not Stripe's published test card");
  }
  if (run.paidSource !== 'tenant-member-state' || run.tenantMemberStatus !== 'paid') {
    failures.push("paid was not confirmed by the tenant's own member state");
  }
  if (!Array.isArray(run.steps) || run.steps.join(',') !== STEPS.join(',')) {
    failures.push(`the steps were not exactly ${STEPS.join(',')}`);
  }
  return failures;
}

/**
 * `run` is capture-checkout.mjs's JSON. Returns failure strings; empty = holds.
 * Holds only when the whole flow completed, the member really is paid, Stripe's
 * script really loaded (so a clean report is not a page that never asked), and
 * no frame reported a single violation. `realMode` is the owner's opt-in run
 * against a real Stripe test-mode account: the capture must then be a real-mode
 * capture and meet judgeRealMode's extra rules; the two kinds never cross.
 */
export function judgeCheckout(run, { realMode = false } = {}) {
  const failures = [];
  const capturedReal = run.mode === REAL_MODE;
  if (realMode && !capturedReal) {
    failures.push('real test mode was requested but this is not a real test-mode capture');
  } else if (!realMode && capturedReal) {
    failures.push('a real test-mode capture judged without the real-mode rules');
  } else if (realMode) {
    failures.push(...judgeRealMode(run));
  }
  if (run.failedAt || run.error) {
    failures.push(
      `the flow stopped (${run.failedAt ?? 'at an unknown step'}): ${run.error ?? 'no error recorded'}`
    );
  }
  if (run.memberSession !== true) {
    failures.push('Ghost did not serve a member session after the sign-in link');
  }
  if (run.checkoutOpened !== true) {
    failures.push('checkout did not open');
  }
  if (run.returnedFromCheckout !== true) {
    failures.push('the visitor did not come back from checkout');
  }
  if (run.paid !== true) {
    failures.push(
      run.paid === false ? 'the member did not become paid' : 'the paid state was not checked'
    );
  }
  if (run.stripeJsLoaded !== true) {
    failures.push(
      'Stripe.js never loaded: either the site is not paid-enabled or the policy blocked it'
    );
  }
  const violations = Array.isArray(run.violations) ? run.violations : [];
  if (violations.length > 0) {
    const named = [...new Set(violations.map((v) => `${v.directive} ${v.blockedURI}`))];
    failures.push(
      `${violations.length} violation(s) across all frames; the policy blocks what checkout needs: ${named.join('; ')}`
    );
  }
  return failures;
}

async function main() {
  const run = JSON.parse(readFileSync(0, 'utf-8'));
  const realMode = process.env.CSP_STRIPE_REAL_TEST_MODE === '1';
  const failures = judgeCheckout(run, { realMode });
  for (const f of failures) console.error(`CSP CHECKOUT GATE RED: ${f}`);
  if (failures.length === 0) {
    console.log(
      `CSP CHECKOUT GATE GREEN${realMode ? ' (real Stripe test mode)' : ''}: steps=${run.steps.join(',')} violations=0 realStripeJs=${run.realStripeJs}`
    );
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

// Same entry discipline as csp-regression-gate.mjs: launched directly, judge;
// argv[1] names this file but does not resolve to it, fail closed (a piped
// capture nobody judged must not exit 0); otherwise we were imported.
const SELF = fileURLToPath(import.meta.url);

function classifyEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return 'imported';
  let resolved = null;
  try {
    resolved = realpathSync(argv1);
  } catch {
    resolved = null;
  }
  if (resolved !== null && resolved === realpathSync(SELF)) return 'main';
  return basename(argv1) === basename(SELF) ? 'misfire' : 'imported';
}

function failClosedOnMisfire() {
  if (process.stdin.isTTY) return;
  const captured = readFileSync(0, 'utf-8');
  if (captured.length === 0) return;
  console.error('CSP CHECKOUT GATE RED: run-as-main guard did not match; capture not judged');
  process.exitCode = 1;
}

const entry = classifyEntry();
if (entry === 'main') {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
} else if (entry === 'misfire') {
  failClosedOnMisfire();
}

#!/usr/bin/env node
// The checkout half of the content-policy proof: one real headless Chromium
// walks a visitor through sign-up, the magic-link round trip, the paid
// upgrade and the return from checkout on a real Ghost behind the edge
// policy, and reports what it observed. It sets no policy (the origin in front
// of Ghost does) and renders no verdict (csp/gate/checkout-gate.mjs does).
//
// The flow, each step recorded only when it really happened:
//   1. sign up through Portal's form (a real visitor's path)
//   2. read the magic link out of the SMTP sink (csp/proof/smtp-sink.mjs)
//   3. follow it, and confirm Ghost now serves a member session
//   4. open Portal's plan chooser, pick the paid plan, and land on the
//      hosted checkout page (csp/proof/fake-stripe.mjs, its own origin)
//   5. pay with Stripe's published test card and come back to ?stripe=success
//   6. confirm the member is paid, from Ghost's own Admin API
//
// Violations come from EVERY frame (Portal is an iframe), through a context
// binding rather than a per-page array, so a blocked script inside Portal's
// frame cannot hide.
//
// Stripe.js. By default js.stripe.com is answered by a stub through Playwright
// routing. A request the policy blocks never reaches routing (Chromium checks
// the source list first), so the browser's own matching is still what is
// tested. CSP_STRIPE_REAL_JS=1 drops the stub and loads the real Stripe.js
// over the internet; that needs no account and no secret.
import { chromium } from 'playwright';

const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4321';
const SINK = process.env.PROOF_SINK_URL || 'http://127.0.0.1:4323';
const STRIPE = process.env.PROOF_STRIPE_URL || 'http://localhost:4322';
const COOKIE = process.env.PROOF_SESSION_COOKIE || '';
const LABEL = process.env.PROOF_LABEL || 'checkout';
const REAL_STRIPE_JS = process.env.CSP_STRIPE_REAL_JS === '1';
const EMAIL = process.env.PROOF_MEMBER_EMAIL || 'checkout-member@example.test';
// Stripe's published success test card. Nothing else is ever typed.
const TEST_CARD = '4242 4242 4242 4242';

const STRIPE_JS_STUB = 'window.Stripe=function(){return{}};window.__stripeStubLoaded=true;';
// Not the `iframe[src*="portal"]` fallback capture-csp.mjs carries: with the real
// Stripe.js loaded, Stripe's own hidden iframe has "portal" in its URL fragment.
const PORTAL_FRAME = 'iframe[title="portal-popup"], iframe.gh-portal-popup-iframe';

async function until(description, fn, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  const result = {
    label: LABEL,
    realStripeJs: REAL_STRIPE_JS,
    steps: [],
    violations: [],
    magicLinkFollowed: false,
    memberSession: false,
    checkoutOpened: false,
    returnedFromCheckout: false,
    paid: null,
    stripeJsLoaded: false,
    failedAt: null,
    error: null,
  };
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.exposeBinding('__reportCsp', (source, violation) => {
    result.violations.push({ ...violation, frame: source.frame.url() });
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCsp({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        disposition: e.disposition,
        documentURI: e.documentURI,
      });
    });
  });
  if (REAL_STRIPE_JS) {
    context.on('response', (response) => {
      if (response.url().startsWith('https://js.stripe.com/v3') && response.ok()) {
        result.stripeJsLoaded = true;
      }
    });
  } else {
    await context.route('https://js.stripe.com/**', (route) => {
      result.stripeJsLoaded = true;
      return route.fulfill({ contentType: 'application/javascript', body: STRIPE_JS_STUB });
    });
  }

  const page = await context.newPage();
  const step = (name) => result.steps.push(name);

  try {
    // 1. Sign up through Portal.
    await page.goto(`${ORIGIN}/#/portal/signup/free`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector(PORTAL_FRAME, { timeout: 15000 });
    const portal = page.frameLocator(PORTAL_FRAME);
    await portal.locator('input[name="name"]').fill('Checkout Member');
    await portal.locator('input[type="email"]').fill(EMAIL);
    await portal.getByRole('button', { name: 'Sign up' }).click();
    await portal.getByText('Now check your email').waitFor({ timeout: 15000 });
    step('signed-up');

    // 2. The link, out of the real SMTP conversation Ghost had.
    const mail = await until('the magic-link email', async () => {
      const res = await fetch(`${SINK}/link?to=${encodeURIComponent(EMAIL)}`);
      return res.ok ? res.json() : null;
    });
    step('magic-link-received');

    // 3. Follow it. Ghost sets the member cookie and redirects to the site.
    await page.goto(mail.link, { waitUntil: 'networkidle', timeout: 30000 });
    result.magicLinkFollowed = true;
    step('magic-link-followed');
    const me = await until('a member session', async () => {
      const res = await page.request.get(`${ORIGIN}/members/api/member/`);
      return res.ok() ? res.json() : null;
    });
    result.memberSession = me.email === EMAIL;
    if (result.memberSession) step('member-session');

    // 4. Open the plan chooser and take the paid plan to checkout.
    await page.goto(`${ORIGIN}/#/portal/account/plans`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForSelector(PORTAL_FRAME, { timeout: 15000 });
    const plans = page.frameLocator(PORTAL_FRAME);
    const choosePlan = plans.getByRole('button', { name: 'Continue' });
    await choosePlan.waitFor({ timeout: 15000 });
    await Promise.all([
      page.waitForURL(`${STRIPE}/c/pay/**`, { timeout: 30000 }),
      choosePlan.click(),
    ]);
    await page.locator('#fake-checkout').waitFor({ timeout: 10000 });
    result.checkoutOpened = true;
    step('checkout-opened');

    // 5. Pay with the published test card; the fake redirects to success_url.
    await page.locator('#cardnumber').fill(TEST_CARD);
    await Promise.all([
      page.waitForURL(/[?&]stripe=success/, { timeout: 30000 }),
      page.locator('#pay').click(),
    ]);
    await page.waitForLoadState('networkidle');
    result.returnedFromCheckout = true;
    step('returned-from-checkout');

    // 6. Paid, according to Ghost's Admin API (the webhook is asynchronous).
    if (COOKIE) {
      const member = await until(
        'the member to be paid',
        async () => {
          const res = await fetch(
            `${ORIGIN}/ghost/api/admin/members/?filter=${encodeURIComponent(`email:'${EMAIL}'`)}`,
            { headers: { Cookie: COOKIE, Origin: ORIGIN } }
          );
          const body = await res.json();
          const m = body.members?.[0];
          return m && m.status === 'paid' ? m : null;
        },
        { timeoutMs: 30000 }
      ).catch(() => null);
      result.paid = Boolean(member);
      if (member) step('paid');
    }
    await page.waitForTimeout(1500); // let any deferred reports land
  } catch (err) {
    result.failedAt =
      result.steps.length === 0 ? 'start' : `after ${result.steps[result.steps.length - 1]}`;
    result.error = String(err.message || err).split('\n')[0];
    if (process.env.PROOF_DEBUG === '1') {
      // What the visitor was looking at when it stopped, for whoever debugs it.
      for (const frame of page.frames()) {
        const text = await frame
          .locator('body')
          .innerText({ timeout: 2000 })
          .catch(() => '');
        const buttons = await frame
          .locator('button')
          .evaluateAll((els) => els.map((e) => `${e.innerText.trim()}|${e.className}`))
          .catch(() => []);
        console.error(
          `[debug] frame ${frame.url()}\n${text.slice(0, 600)}\nbuttons: ${JSON.stringify(buttons)}`
        );
      }
    }
  }

  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

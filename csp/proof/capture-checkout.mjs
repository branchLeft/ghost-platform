#!/usr/bin/env node
// The checkout half of the content-policy proof: one real headless Chromium
// takes a member through the paid upgrade and back from checkout, and reports
// what it observed. It sets no policy and renders no verdict.
// The flow and the frame and Stripe.js notes: csp/proof/run-proof.md (checkout section).
import { chromium } from 'playwright';
import {
  PUBLISHED_TEST_CARD,
  assertLocalTenant,
  assertPublishedTestCard,
  isTenantViolation,
  redactSecrets,
  secretValues,
} from './real-test-mode.mjs';

const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4321';
const STRIPE = process.env.PROOF_STRIPE_URL || 'http://localhost:4322';
const COOKIE = process.env.PROOF_SESSION_COOKIE || '';
const LABEL = process.env.PROOF_LABEL || 'checkout';
const REAL_MODE = process.env.PROOF_REAL_TEST_MODE === '1';
const REAL_STRIPE_JS = process.env.CSP_STRIPE_REAL_JS === '1' || REAL_MODE;
const EMAIL = process.env.PROOF_MEMBER_EMAIL || 'checkout-member@example.test';
// Stripe's published success test card. Nothing else is ever typed.
const TEST_CARD = '4242 4242 4242 4242';
const scrub = (text) => (REAL_MODE ? redactSecrets(text, secretValues(process.env)) : text);

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

async function admin(path, method, body) {
  const res = await fetch(`${ORIGIN}/ghost/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: COOKIE },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

// Stripe's hosted Checkout page. UNVERIFIED against the live page: these
// locators are the ones Stripe's public docs and test fixtures use, with a
// label fallback for each; the owner's first run is what verifies them.
async function payOnStripe(page, card, result) {
  const expiryYear = String((new Date().getFullYear() + 3) % 100).padStart(2, '0');
  await page
    .getByPlaceholder('1234 1234 1234 1234')
    .or(page.getByLabel('Card number'))
    .first()
    .fill(card);
  result.cardTyped = card;
  await page
    .getByPlaceholder('MM / YY')
    .or(page.getByLabel(/expir/i))
    .first()
    .fill(`12 / ${expiryYear}`);
  await page.getByPlaceholder('CVC').or(page.getByLabel('CVC')).first().fill('123');
  const name = page
    .getByPlaceholder('Full name on card')
    .or(page.getByLabel(/name on card|cardholder/i));
  if (await name.count()) await name.first().fill('Checkout Member');
  const postcode = page.getByLabel(/zip|postal code|postcode/i);
  if (await postcode.count()) await postcode.first().fill('12345');
  await page
    .getByTestId('hosted-payment-submit-button')
    .or(page.getByRole('button', { name: /^(pay|subscribe)/i }))
    .first()
    .click();
}

async function main() {
  if (REAL_MODE) {
    assertLocalTenant(ORIGIN);
    assertPublishedTestCard(process.env.CSP_STRIPE_TEST_CARD ?? PUBLISHED_TEST_CARD);
  }
  const result = {
    label: LABEL,
    realStripeJs: REAL_STRIPE_JS,
    steps: [],
    violations: [],
    memberSession: false,
    checkoutOpened: false,
    returnedFromCheckout: false,
    paid: null,
    stripeJsLoaded: false,
    failedAt: null,
    error: null,
  };
  if (REAL_MODE) {
    result.mode = 'real-test-mode';
    result.foreignViolations = 0;
  }
  if (!COOKIE) {
    console.error(
      'capture-checkout: PROOF_SESSION_COOKIE is required (setup-content.mjs prints it)'
    );
    process.exit(2);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.exposeBinding('__reportCsp', (source, violation) => {
    if (REAL_MODE && !isTenantViolation(violation, ORIGIN)) {
      result.foreignViolations += 1;
      return;
    }
    result.violations.push({ ...violation, frame: scrub(source.frame.url()) });
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
    // 1. A free member, and the sign-in link Ghost issues for it.
    const created = await admin('/members/', 'POST', {
      members: [{ email: EMAIL, name: 'Checkout Member' }],
    });
    const memberId = created.members[0].id;
    step('member-created');
    const issued = await admin(`/members/${memberId}/signin_urls/`, 'GET');
    await page.goto(issued.member_signin_urls[0].url, { waitUntil: 'networkidle', timeout: 30000 });
    step('sign-in-link-followed');

    // 2. Ghost serves a member session.
    const me = await until('a member session', async () => {
      const res = await page.request.get(`${ORIGIN}/members/api/member/`);
      return res.ok() ? res.json() : null;
    });
    result.memberSession = me.email === EMAIL;
    if (result.memberSession) step('member-session');

    // 3. Open the plan chooser and take the paid plan to checkout.
    await page.goto(`${ORIGIN}/#/portal/account/plans`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForSelector(PORTAL_FRAME, { timeout: 15000 });
    const plans = page.frameLocator(PORTAL_FRAME);
    const choosePlan = plans.getByRole('button', { name: 'Continue' });
    await choosePlan.waitFor({ timeout: 15000 });
    await Promise.all([
      page.waitForURL(REAL_MODE ? /^https:\/\/checkout\.stripe\.com\// : `${STRIPE}/c/pay/**`, {
        timeout: 30000,
      }),
      choosePlan.click(),
    ]);
    if (REAL_MODE) {
      const hosted = new URL(page.url());
      result.checkoutHost = hosted.hostname;
      result.checkoutSessionIsTest = hosted.pathname.includes('/cs_test_');
      if (!result.checkoutSessionIsTest) {
        throw new Error(
          'refusing to type a card: the checkout session is not a Stripe test-mode session'
        );
      }
      await page
        .getByPlaceholder('1234 1234 1234 1234')
        .or(page.getByLabel('Card number'))
        .first()
        .waitFor({ timeout: 30000 });
    } else {
      await page.locator('#fake-checkout').waitFor({ timeout: 10000 });
    }
    result.checkoutOpened = true;
    step('checkout-opened');

    // 4. Pay with the published test card; the fake (or, in real test mode,
    // Stripe's own page) redirects to success_url.
    if (REAL_MODE) {
      await Promise.all([
        page.waitForURL(/[?&]stripe=success/, { timeout: 60000 }),
        payOnStripe(page, PUBLISHED_TEST_CARD, result),
      ]);
    } else {
      await page.locator('#cardnumber').fill(TEST_CARD);
      await Promise.all([
        page.waitForURL(/[?&]stripe=success/, { timeout: 30000 }),
        page.locator('#pay').click(),
      ]);
    }
    await page.waitForLoadState('networkidle');
    result.returnedFromCheckout = true;
    step('returned-from-checkout');

    // 5. Paid, according to Ghost's Admin API (the webhook is asynchronous).
    const member = await until(
      'the member to be paid',
      async () => {
        const body = await admin(`/members/${memberId}/`, 'GET');
        const m = body.members?.[0];
        return m && m.status === 'paid' ? m : null;
      },
      { timeoutMs: REAL_MODE ? 60000 : 30000 }
    ).catch(() => null);
    result.paid = Boolean(member);
    if (REAL_MODE) {
      // The tenant's own member state, never anything the checkout page says.
      result.paidSource = 'tenant-member-state';
      result.tenantMemberStatus = member ? member.status : 'not-paid';
    }
    if (member) step('paid');
    await page.waitForTimeout(1500); // let any deferred reports land
  } catch (err) {
    result.failedAt =
      result.steps.length === 0 ? 'start' : `after ${result.steps[result.steps.length - 1]}`;
    result.error = scrub(String(err.message || err).split('\n')[0]);
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
          scrub(
            `[debug] frame ${frame.url()}\n${text.slice(0, 600)}\nbuttons: ${JSON.stringify(buttons)}`
          )
        );
      }
    }
  }

  await browser.close();
  console.log(scrub(JSON.stringify(result, null, 2)));
}

main().catch((err) => {
  console.error(REAL_MODE ? scrub(String(err.stack || err)) : err);
  process.exit(2);
});

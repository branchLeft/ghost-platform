#!/usr/bin/env node
// Turns a Ghost that setup-content.mjs has already taken through its owner
// wizard into a paid-enabled site: open member sign-up, Stripe keys, and a
// public paid tier with prices. Reuses setup-content.mjs's admin session
// (PROOF_SESSION_COOKIE) instead of logging in a second time -- the reason
// is recorded there.
//
// TEST MODE ONLY. The secret key must start `sk_test_`; the script refuses
// anything else before it makes a single request, so a live key can never
// reach a Ghost this proof configures. The keys are synthetic strings made up
// per run by the gate -- Ghost only validates their shape (`sk_test_` plus
// alphanumerics) -- and the Stripe it talks to is csp/proof/fake-stripe.mjs.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4321';
const COOKIE = process.env.PROOF_SESSION_COOKIE;
const SECRET_KEY = process.env.PROOF_STRIPE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.PROOF_STRIPE_PUBLISHABLE_KEY || '';
// Different from Ghost's seeded defaults (500/5000): Ghost creates the Stripe
// product and prices only when a tier's price changes, never for the seed.
const MONTHLY = 900;
const YEARLY = 9000;

export function assertTestKeys(secretKey, publishableKey) {
  if (!/^sk_test_[0-9a-zA-Z]+$/.test(secretKey)) {
    throw new Error('refusing: the Stripe secret key must be a sk_test_ key (test mode only)');
  }
  if (!/^pk_test_[0-9a-zA-Z]+$/.test(publishableKey)) {
    throw new Error('refusing: the Stripe publishable key must be a pk_test_ key (test mode only)');
  }
}

async function call(path, method, body) {
  const res = await fetch(ORIGIN + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: COOKIE },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable body>');
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  assertTestKeys(SECRET_KEY, PUBLISHABLE_KEY);
  if (!COOKIE) throw new Error('PROOF_SESSION_COOKIE is required (setup-content.mjs prints it)');

  await call('/ghost/api/admin/settings/', 'PUT', {
    settings: [
      { key: 'stripe_secret_key', value: SECRET_KEY },
      { key: 'stripe_publishable_key', value: PUBLISHABLE_KEY },
      { key: 'members_signup_access', value: 'all' },
      // Without this Portal offers no paid plan at all ("no paid plans are available").
      { key: 'portal_plans', value: JSON.stringify(['free', 'monthly', 'yearly']) },
    ],
  });

  const { tiers } = await call('/ghost/api/admin/tiers/', 'GET');
  const paid = tiers.find((tier) => tier.type === 'paid');
  if (!paid) throw new Error('setup: no paid tier in this Ghost');
  const updated = await call(`/ghost/api/admin/tiers/${paid.id}/`, 'PUT', {
    tiers: [
      {
        name: 'Proof Plan',
        currency: 'usd',
        monthly_price: MONTHLY,
        yearly_price: YEARLY,
        visibility: 'public',
        active: true,
      },
    ],
  });
  const tier = updated.tiers[0];
  if (tier.monthly_price !== MONTHLY || tier.yearly_price !== YEARLY) {
    throw new Error(`setup: tier prices did not take: ${JSON.stringify(tier)}`);
  }
  console.log(`PAID_TIER_ID=${tier.id}`);
}

const launchedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

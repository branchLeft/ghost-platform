# csp-checkout-gate: Stripe checkout and the magic-link round trip under the strict policy

The strict content policy (`csp/README.md`) was first measured against Portal's
sign-in form only. This gate proves the other side: that **legitimate** payment
traffic is not blocked. It is the standing check LLD-5 asks for ("C1 must be
re-run before the first paying tenant takes a card") and the sibling of
`csp-regression-gate.mjs`, which proves **hostile** content is blocked.

## What it found

Ghost 6.55.0 (the pinned image) emits `<script async
src="https://js.stripe.com/v3/">` from `ghost_head` on **every page** of any site
with paid members enabled, not only at checkout. Under the policy as it was
before this gate, a paid tenant throws a `script-src-elem` violation on every
page load, and Stripe.js's own hidden frames throw `frame-src` violations. So a
paid tenant could never satisfy `csp-regression-gate.mjs`'s "exactly one
violation" rule; that gate is for sites without payments, and this one is for
sites with them.

Measured live with the real Stripe.js, against the strict policy served
report-only: `script-src` and `frame-src` need `https://js.stripe.com`, and no
`connect-src` origin was reported, so none is allowed. The set lives in
`render-core/src/payments-origins.json` and is written only by
`csp/derive/derive-payment-origins.mjs`.

A second finding, stated plainly: blocking Stripe.js does **not** stop Ghost's
redirect-to-checkout flow. The control run completes every step and the member
is paid. Stripe.js is Stripe's fraud-signal and telemetry script here, not what
carries the payment. So the gate's failing signal is the violation report (and
Stripe.js never loading), not a broken page.

## The flow it drives

1. Sign up through Portal's form.
2. Read the magic link out of the SMTP sink (`csp/proof/smtp-sink.mjs`).
3. Follow it and confirm Ghost serves a member session.
4. Open Portal's plan chooser, pick the paid plan, land on the hosted checkout
   page (`csp/proof/fake-stripe.mjs`, on its own origin).
5. Pay with Stripe's published test card and return to `?stripe=success`.
6. Confirm the member is `paid` from Ghost's Admin API.

Violations come from **every frame** (Portal is an iframe), through a context
binding rather than a per-page array.

## `checkout-gate.mjs` / `csp-checkout-gate.sh`

`judgeCheckout` is the verdict on `csp/proof/capture-checkout.mjs` output. Green
only when: no flow error, the link was followed, a member session exists, checkout
opened, the visitor came back, the member is paid, Stripe.js really loaded (a
clean report from a page that never asked proves nothing), and **zero**
violations across all frames.

```sh
./csp/gate/csp-checkout-gate.sh [--sabotage=no-stripe-origin] [--derive] [IMAGE]
```

Needs Docker, `csp/proof`'s own `pnpm install` for Playwright, and render-core
built. It starts a fake Stripe API, an SMTP sink and a Ghost on a private
network; sets Ghost up as a paid site with **synthetic per-run test keys**; and
serves the policy `renderEdgeSiteBlock(..., { kind: 'stripe' })` renders,
enforcing. Ghost's Stripe client is pointed at the fake with
`STRIPE_API_HOST/PORT/PROTOCOL`, `stripeDirect=true` and `WEBHOOK_SECRET`.

- `--sabotage=no-stripe-origin`: the same Ghost with the `payments: none`
  policy (the policy as it was). Must exit non-zero, naming
  `script-src-elem https://js.stripe.com/v3/`. This is the control case.
- `--derive` (needs `CSP_STRIPE_REAL_JS=1`): measures, does not judge. Serves
  the policy with no payments allowance **report-only**, runs the flow against
  the real Stripe.js, and runs `derive-payment-origins.mjs --check` against the
  committed allowlist.
- `CSP_STRIPE_REAL_JS=1` on its own loads the real Stripe.js from the internet
  instead of a stub answered by Playwright routing. It needs no account and no
  secret. By default (hermetic) the stub proves the policy is applied, since a
  request the policy blocks never reaches routing; the real run proves the
  allowlist is the right one.

## What this does NOT prove

- **Stripe's own pages.** The hosted checkout page here is a fake on a local
  origin. Real Checkout is on `checkout.stripe.com`, reached by top-level
  navigation, which a Content-Security-Policy on the tenant does not govern.
  What is proved is Ghost's own pages under the policy.
- **Real webhooks.** The fake signs `checkout.session.completed` with the real
  Stripe scheme and Ghost verifies it with a secret we hold, but Stripe's
  delivery is not exercised.
- **A real inbox.** The magic link comes from a local SMTP sink, not the mail
  programme (LLD-6).
- **Stripe Elements or other client-side payment UI.** Ghost uses hosted
  checkout; a site that embeds Stripe Elements would need `api.stripe.com` in
  `connect-src` and must be re-measured.

The live proof of those needs Rob's own Stripe TEST-mode account (free, no
charge) with a Stripe CLI listener, and the mail programme being live. Neither
is needed to run this gate.

## Tests

`node --test csp/gate/*.test.mjs csp/derive/*.test.mjs csp/proof/*.test.mjs`, and
`csp/gate/prove-gates.sh` mutates each verdict rule (and the derivation's
refusals) and requires the tests to go red, then green. The `edge.ts` side is
`render-core/test/edge.test.ts` and a source-mutation case in
`sourceMutation.sabotage.test.ts`. The live gate is not in CI (Docker and
Chromium), like `csp-regression-gate.sh`.

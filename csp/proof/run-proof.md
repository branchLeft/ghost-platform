# run-proof.sh

## Overview

The live proof for the strict content policy: a real pinned Ghost, a real
theme, a real Caddy in front, a real headless Chromium — driven through the
exact attack a prior spike measured.

1. Boot a clean Ghost + this story's Caddy origin (self-hosted widgets, from
   `widgets/dist/`, so Portal never reaches a third-party origin).
2. Take Ghost through setup and create one tagged, published post.
3. Derive the theme's real script-hash set from the CLEAN pages — home,
   post, tag, author — with `derive-script-hashes.mjs`, exactly the way a
   real theme-admission step would, before any attack exists.
4. Inject the same hostile `codeinjection_head` the spike used.
5. ROW A — no policy at all: the attack runs, zero violations (the control:
   this proof's own harness can actually see the attack).
6. ROW B — the enforcing policy `render-header.mjs` renders through
   render-core's own built output, with the derived hashes: the attack is
   blocked, Portal's sign-in form still renders with its email field, and
   exactly one violation fires (the attack alone).
7. ROW D (SABOTAGE) — the real, unmutated "unavailable" policy (`script-src
   'self'`, no hash allowance) wired in as an ENFORCING
   Content-Security-Policy header rather than the Report-Only header its own
   `contentSecurityPolicyMode` says to use — the exact wiring bug this
   story's fail-soft mark exists to prevent. The attack is still blocked,
   but Ghost's own inline blocks (the theme helper, the JSON-LD block) are
   now blocked too: MORE than one violation fires, and the "exactly one"
   assertion goes red.
8. ROW E (SABOTAGE) -- each hash the home page carries dropped from the derived
   set in turn: at least one drop makes an inline block of Ghost's own go
   unhashed, so it is refused and more than one violation fires (red).
9. ROW B again — the correct wiring restored: back to exactly one
   violation, proving the sabotage is what broke it.

## Usage

```sh
./csp/proof/run-proof.sh
```

Needs Docker, and `csp/proof`'s own `pnpm install` for Playwright (see
`csp/proof/package.json`) — kept out of the root `package.json` and out of
CI deliberately, like `widgets/proof/`.

## checkout proof script (capture-checkout.mjs)

It sets no policy (the origin in front of Ghost does) and renders no verdict
(csp/gate/checkout-gate.mjs does).

The flow, each step recorded only when it really happened:
  1. create a free member through the Admin API and follow the sign-in link
     Ghost's Admin API issues for it (NOT the magic-link email: that round
     trip waits on the mail programme and is not proven here)
  2. confirm Ghost now serves a member session
  3. open Portal's plan chooser, pick the paid plan, and land on the hosted
     checkout page (csp/proof/fake-stripe.mjs, its own origin)
  4. pay with Stripe's published test card and come back to ?stripe=success
  5. confirm the member is paid, from Ghost's own Admin API

Violations come from EVERY frame (Portal is an iframe), through a context
binding rather than a per-page array, so a blocked script inside Portal's
frame cannot hide.

Stripe.js. By default js.stripe.com is answered by a stub through Playwright
routing. A request the policy blocks never reaches routing (Chromium checks
the source list first), so the browser's own matching is still what is
tested. CSP_STRIPE_REAL_JS=1 drops the stub and loads the real Stripe.js
over the internet; that needs no account and no secret.

Real test mode (PROOF_REAL_TEST_MODE=1, set by csp-checkout-gate.py when the
owner opts in): the checkout page is Stripe's own (checkout.stripe.com),
Stripe.js is always the real one, and the card typed is checked against the
published test card before the browser starts. A violation counts only when
the tenant's own document raised it; Stripe's pages answer to Stripe's
policy. Everything this process prints goes through redactSecrets.

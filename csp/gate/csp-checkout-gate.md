# csp/gate: the checkout gate

The other side of the content-policy regression gate. That gate proves hostile
content is blocked; this one proves legitimate payment traffic is not. A paid
Ghost emits `<script src="https://js.stripe.com/v3/">` on every page, so under
the strict policy without a Stripe allowance every page of a paid tenant throws a
`script-src-elem` violation. The two gates are separate because a paid site cannot
satisfy the regression gate's "exactly one violation" rule while the policy lacks
Stripe.

## What it runs

`csp-checkout-gate.py` (Docker, Chromium via `csp/proof`, render-core built):

1. Starts the pinned Ghost image, a fake Stripe API (`csp/proof/fake-stripe.mjs`)
   and a Caddy origin whose `Content-Security-Policy` header is the value
   render-core renders (`csp/proof/render-header.mjs`, `CSP_PAYMENTS=stripe`).
   Ghost reaches the fake because `STRIPE_API_HOST`, `STRIPE_API_PORT` and
   `STRIPE_API_PROTOCOL` point its Stripe client there.
2. `csp/proof/setup-paid.mjs` turns on member sign-up, sets synthetic per-run
   `sk_test_` and `pk_test_` keys and a public paid tier with prices.
3. `csp/proof/capture-checkout.mjs` drives a real Chromium: a member is created
   through the Admin API and signs in through the sign-in link the Admin API
   issues, opens Portal's plan chooser, takes the paid plan to the hosted
   checkout page, pays with Stripe's published test card and returns. It then
   checks, from Ghost's Admin API, that the member is **paid**. Violations are
   collected from every frame (Portal is an iframe).
4. `checkout-gate.mjs` judges the capture. Green only when the whole flow
   completed, the member is paid, Stripe.js really loaded (so a clean report is
   not a page that never asked for it) and no frame reported a single violation.

Modes:

- no flag: the enforcing policy rendered with `payments: stripe`. Must exit 0.
- `--sabotage=no-stripe-origin`: the same Ghost under the policy rendered with
  `payments: none`, which is the policy as it was before the allowance existed.
  Must exit 1 and name `script-src-elem https://js.stripe.com/v3/`.
- `--derive` (needs `CSP_STRIPE_REAL_JS=1`): serves the strict policy with no
  allowance **report-only** against the real Stripe.js and compares what the
  browser reported with `render-core/src/payments-origins.json`
  (`csp/derive/derive-payment-origins.mjs --check`). Run it when the Ghost pin
  moves.
- `CSP_STRIPE_REAL_JS=1`: load the real Stripe.js over the internet instead of a
  stub answered through Playwright routing. Needs no account and no secret.

Blocking Stripe.js does not break Ghost's hosted-checkout flow (Ghost redirects
to the hosted page and Stripe.js is Stripe's fraud-signal script), so the control
fails on the violation report and on "Stripe.js never loaded", not on a broken
page.

## What it does not prove

- **Real Checkout on Stripe's own page.** The member leaves the tenant by
  top-level navigation, which the tenant policy does not govern. The hosted page
  here is the fake's. Proving it needs a Stripe **test-mode** account and a
  webhook listener, which are the owner's; nothing here creates an account or
  uses a real key (the fake refuses any key that is not `sk_test_`, and any card
  but the published test card).
- **The magic-link email round trip.** The member signs in through an Admin API
  sign-in link, not the email. That half waits on the mail programme.
- **Anything deployed.** Nothing passes `payments: stripe` to a deployed edge
  yet; wiring it through the broker and provisioner is separate work.

## Tests

`node --test csp/gate/*.test.mjs csp/derive/*.test.mjs csp/proof/*.test.mjs`
(needs `render-core` built). `csp/gate/prove-gates.sh` mutates each verdict rule
and each derivation refusal and requires the tests to go red, then green.
`render-core/test/edge.test.ts` pins the rendered policy to exactly the measured
origins and carries source-mutation sabotage for the allowance, the origin-shape
check and a stray origin.

The runner itself is Python (`csp-checkout-gate.py`, standard library only).
`python3 -m unittest discover -s csp/gate -p 'test_csp_checkout_gate.py' -v`
runs it against recording fakes for docker, node and curl, so it needs no Docker
or browser and runs in CI. The same file mutates the real source (a wrong exit
code, a skipped refusal, a dropped cleanup, a swallowed failure) and requires
the tests to go red for each. Arguments, environment variables, exit codes and
output lines are those of the shell script it replaced.

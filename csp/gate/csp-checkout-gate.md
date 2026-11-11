# csp/gate: the checkout gate

The other side of the content-policy regression gate. That gate proves hostile
content is blocked; this one proves legitimate payment traffic is not. A paid
Ghost emits `<script src="https://js.stripe.com/v3/">` on every page, so under
the strict policy without a Stripe allowance every page of a paid tenant throws a
`script-src-elem` violation. The two gates are separate because a paid site cannot
satisfy the regression gate's "exactly one violation" rule while the policy lacks
Stripe.

## What it runs

`csp-checkout-gate.sh` (Docker, Chromium via `csp/proof`, render-core built):

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

- `CSP_STRIPE_REAL_TEST_MODE=1`: the owner's opt-in run against Stripe's own
  hosted Checkout with a Stripe **test-mode** account. See "Real test mode".
  Unset, the fake runs exactly as above.

Blocking Stripe.js does not break Ghost's hosted-checkout flow (Ghost redirects
to the hosted page and Stripe.js is Stripe's fraud-signal script), so the control
fails on the violation report and on "Stripe.js never loaded", not on a broken
page.

## Real test mode

Opt-in only, and only by the owner: nothing in CI or in an agent's run sets the
switch or holds a key. `csp/gate/csp-checkout-gate.sh --help` prints the exact
command. The three values come from the shell environment only (never a file,
never an argument, never echoed):

```sh
read -rs STRIPE_TEST_SECRET_KEY; export STRIPE_TEST_SECRET_KEY
read -rs STRIPE_TEST_PUBLISHABLE_KEY; export STRIPE_TEST_PUBLISHABLE_KEY
read -rs STRIPE_TEST_WEBHOOK_SECRET; export STRIPE_TEST_WEBHOOK_SECRET
CSP_STRIPE_REAL_TEST_MODE=1 csp/gate/csp-checkout-gate.sh
```

Needs Docker, render-core built, Chromium installed in `csp/proof`, and the
Stripe CLI logged in to the test-mode account with a second terminal running
`stripe listen --forward-to http://localhost:4321/members/webhooks/stripe/`
(the port is `CSP_CHECKOUT_PORT`, default 4321; `stripe listen --print-secret`
prints the signing secret for `STRIPE_TEST_WEBHOOK_SECRET`). The gate never runs
the Stripe CLI.

What it does differently: no fake Stripe starts and Ghost keeps its default
Stripe API host; the real Stripe.js loads; the browser follows the member to
`checkout.stripe.com` (a `cs_test_` session), types the published test card
only, and returns to the tenant. Green needs everything the fake run needs plus
the page host, a test-mode session, the card, `paid` read from the tenant's own
member state (not anything Stripe's page shows), all six steps in order, and
zero violations raised by the tenant's own documents (Stripe's pages answer to
Stripe's policy and are counted apart as `foreignViolations`).

What the switch refuses before any container starts, naming the variable and
never printing a value (`csp/proof/real-test-mode.mjs`, tested in
`real-test-mode.test.mjs`):

- a key that is unset or empty;
- a secret key that is not `^sk_test_[A-Za-z0-9]+$` (a live key and any
  restricted `rk_` key are refused, test or live);
- a publishable key that is not `^pk_test_[A-Za-z0-9]+$`;
- a webhook secret that is not `^whsec_[A-Za-z0-9]+$`;
- a tenant origin that is not `http://localhost:<port>` or
  `http://127.0.0.1:<port>`; the same check stands again before the keys are sent
  to Ghost and before the browser starts;
- a card number other than `4242 4242 4242 4242` (`CSP_STRIPE_TEST_CARD`, if
  set; the capture re-checks it);
- `--derive` (it measures with no keys), and a switch value other than `1`.

What it lets through: any `sk_test_`/`pk_test_`/`whsec_` value of the right shape
(the shape is not proof the key is the owner's, or belongs to the account the
`stripe listen` is logged in to); a card entry on Stripe's own page by
Playwright locators that are unverified until the first owner run; and a webhook
listener it cannot see (a missing one shows as `the member did not become paid`
after 60 s). Redaction is on every line the node side prints (key-shaped
strings, the exact values in the environment, and the fragment of the checkout
URL), and the script sets `set +x`.

## What it does not prove

- **Real Checkout on Stripe's own page, in an agent's or CI's run.** The member
  leaves the tenant by top-level navigation, which the tenant policy does not
  govern. In the default run the hosted page is the fake's: nothing there creates
  an account or uses a real key (the fake refuses any key that is not
  `sk_test_`, and any card but the published test card). The real page is
  proven only by the owner's run in real test mode above.
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

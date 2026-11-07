# derive-payment-origins.mjs

The payments sibling of `derive-script-hashes.mjs`. That tool measures the
theme's inline scripts; this one measures what a paid site's Stripe.js pulls in,
and turns it into the per-directive origin allowlist `renderEdgeSiteBlock` adds
when it is given `{ kind: 'stripe' }`.

The allowlist is **derived, not hand-maintained** (the issue's item 4). The
file it writes, `render-core/src/payments-origins.json`, has no other author.

## Input

stdin: the JSON `csp/proof/capture-checkout.mjs` prints, for a run that is

- against the **real** Stripe.js (`CSP_STRIPE_REAL_JS=1`); a stub measures
  nothing, and
- under the strict policy with **no** payments allowance, served
  **report-only**. An enforcing run stops at the first blocked script, so the
  frames and requests that would have followed never happen and the set comes
  out short; the next deploy then breaks on the origin that was hidden.

The tool refuses a capture that is neither. `csp-checkout-gate.sh --derive` makes
exactly this run.

## What it refuses

It maps `script-src-elem`/`script-src`, `frame-src` and `connect-src` violations
to the directive an allowance extends. Anything else is reported, never ignored:
an unmapped directive, a non-https or non-Stripe origin (`stripe.com`,
`stripe.network` and their subdomains only), an enforced violation, a stub
capture, or a capture that reported no Stripe origin at all. A refused capture
exits non-zero and writes nothing, so a hostile or accidental third-party request
in a capture cannot widen the policy.

## Usage

```sh
node csp/derive/derive-payment-origins.mjs < capture.json           # print
node csp/derive/derive-payment-origins.mjs --write < capture.json   # write the allowlist
node csp/derive/derive-payment-origins.mjs --check < capture.json   # exit 1 unless equal
```

`--check` is what the live proof runs: the committed allowlist must equal the
measured set exactly, so it fails both when a new origin appears and when a
listed one is no longer needed.

## Measured on 2026-11-07

Ghost 6.55.0, the real Stripe.js, hosted checkout: `script-src` and `frame-src`
need `https://js.stripe.com`; `connect-src` was empty. Re-measure when the Ghost
pin moves (the `<script>` tag is emitted by Ghost) or if a site embeds Stripe
Elements.

## Tests

`node --test csp/derive/derive-payment-origins.test.mjs`; mutations of each
refusal are in `csp/gate/prove-gates.sh`.

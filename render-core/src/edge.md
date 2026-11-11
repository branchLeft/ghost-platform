# edge.ts

## Admitted vs display hostname

`admittedHostname` is never `displayHostname`. `validate.ts#servedHostnameOf`'s
own doc comment states the reason a demo must never reach on-demand TLS
admission under its own hostname: a demo slot sits under a platform wildcard
certificate, and asking per-hostname for one would put a reusable slot's
current name into a public, append-only CT log for good, which the
never-reuse rule for slot names cannot tolerate. This module keeps that as
two separate fields rather than one, precisely so a caller cannot use the
human-readable hostname for a certificate decision by accident:
`displayHostname` is always the descriptor's own host (safe to show, redirect
to, log); `admittedHostname` is `servedHostnameOf`'s own answer, `null` for
every demo.

## The strict content policy

`script-src` is `'self'` plus the theme's own derived inline-script hash
set — never a hand-written list; see `ThemeCsp` below. The hash set is
deliberately not a `TenantDescriptor` field: it is operational state that
changes on every theme upload, not part of what a tenant was promised, and
`render-core/src/lease.ts`'s `SlotLeaseRecord` already draws that same line
for the same reason. So it arrives here as an explicit parameter, computed
upstream by the derivation tool (`csp/derive/`) — this module never computes
a hash itself, only renders one it was handed. The hash set is always
derived, never hand-set, and a theme whose set could not be computed gets the
report-only policy plus a flag — an enforcing policy is never guessed.
`style-src 'unsafe-inline'` stays for every tenant: Portal styles the iframe
it builds for itself inline, and that residual is accepted as materially
less dangerous than injected script.

## The payments allowance

A paid Ghost loads `https://js.stripe.com/v3/` on every page, which the strict
policy blocks. `renderEdgeSiteBlock`'s fifth argument, `PaymentsCsp`, adds the
Stripe origins to `script-src` and to an explicit `frame-src` (`default-src` no
longer covers a frame once an allowance exists, so `'self'` is written out
beside the Stripe origin). It defaults to `none`, which renders the policy
exactly as before: like `ThemeCsp` it is an explicit parameter and not a
`TenantDescriptor` field, so a tenant with no payments never gets a wider
`script-src`, and no schema bump is needed.

The origins live in `payments-origins.json` and are **measured**: only
`csp/derive/derive-payment-origins.mjs` writes it, from a real browser's
report-only run against a real Ghost loading the real Stripe.js, and
`csp-checkout-gate.sh --derive` fails when the file drifts from a fresh
measurement. This module renders them and adds none. It also validates each one
on use: a bare https origin on `stripe.com` or `stripe.network`, nothing else, so
a hand edit cannot put a wildcard, a path, a third party or CSP syntax into the
header. The set is exactly `https://js.stripe.com` for `script-src` and
`frame-src` and nothing for `connect-src` (hosted checkout navigates away to
Stripe's own page, which a tenant policy does not govern). A site embedding
Stripe Elements would also need `api.stripe.com` and must be re-measured.

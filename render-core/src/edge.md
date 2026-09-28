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

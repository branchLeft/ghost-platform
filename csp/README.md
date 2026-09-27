# The strict content policy (branchLeft/workspace#1238)

Ghost's own front end emits inline scripts (the theme's helpers, a JSON-LD
block), so `script-src 'self'` alone would block them alongside a
`codeinjection_head` attack (LLD-5 `05-gate-and-edge.html` §04, row D). The
allowed set is a function of Ghost version, theme and theme version, so it
has to be derived, not hand-written — this directory is that derivation
tool plus its live proof. `render-core/src/edge.ts` is the other half: it
renders the header, never computes a hash.

**`derive/`** — `derive-script-hashes.mjs`: fetches a theme's rendered home,
post, tag and author pages from a running Ghost over plain HTTP (server-
rendered HTML, not a browser DOM — LLD-5's own spike measured this as
byte-stable across repeated fetches) and hashes every inline `<script>`
block with no `src` attribute. Deduplicated and sorted, so the result does
not depend on fetch order. Returns `{ kind: 'computed', hashes: [...] }`, or
`{ kind: 'unavailable', reason }` if any page could not be fetched — LLD-5's
own fail-soft mark: a partial hash set is worse than none. Tested with
`node --test derive/derive-script-hashes.test.mjs` (`node:test` and
`node:crypto` only, no install needed — wired into CI the way
`widgets/verify-pins.test.mjs` is, see `repo-tooling-ci.yml`).

**Where the hash set lives, once derived** (the issue's own open question,
decided here, incidental): a `ThemeCsp` value passed into
`renderEdgeSiteBlock`/`render()` as an explicit parameter — never a
`TenantDescriptor` field. It is operational state that changes on every
theme upload, not part of what a tenant was promised, and
`render-core/src/lease.ts`'s `SlotLeaseRecord` already draws that same line
for the same reason (the design's own cross-document review, P1, makes the
general case). `render()`'s new third argument defaults to
`THEME_CSP_UNAVAILABLE`, so every existing caller in this repo (the broker,
demo-gate) keeps compiling and keeps rendering the report-only policy
exactly as before — wiring a real, derived value through a running service
is the harness's job (LLD-3), which does not exist in this repo yet.

**`proof/`** — the live proof LLD-5's own "Done means" asks for: a real
pinned Ghost, this repo's self-hosted widget bundles (`widgets/`, so Portal
never reaches a third-party origin), a real Caddy in front, and a real
headless Chromium, driven through the exact attack the spike measured. One
GREEN baseline (the enforcing policy, with the theme's own derived hashes,
blocks the attack while Portal's sign-in form still renders and exactly one
violation fires), one control (no policy: the attack runs, proving the
harness can see it at all), and one sabotage (the real, unmutated
report-only policy wired in as an *enforcing* header instead — the exact
bug the render core's own `contentSecurityPolicyMode` flag exists to
prevent — which blocks Ghost's own inline scripts too, and the "exactly one
violation" assertion goes red), then a final GREEN restoring the correct
wiring. Needs Docker and `proof/`'s own `npm install` for Playwright — never
run in CI, like `widgets/proof/`. Run it from the repo root:
`./csp/proof/run-proof.sh`.

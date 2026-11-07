# request-guard

The two pieces every service in this repository needs to meter an
unauthenticated route, in one home:

- `src/ceiling.ts`: a bounded, fixed-window, per-key counter
  (`createAttemptCeiling`).
- `src/source.ts`: the trusted-proxy resolver that decides which address a
  request is keyed on (`createSourceResolver`, `parseTrustedProxies`).

The demo gate (`services/demo-gate`), the tenant portal and the owner console
(`portal/apps`) link this package by path and import its built output,
`ghost-platform-request-guard/dist/index.js`, the same way `portal/apps`
imports `ghost-platform-identity`. Build it first (`pnpm run build`); each
consumer's CI and Dockerfile do.

## The ceiling and its overflow policy

`createAttemptCeiling({ limit, windowMs, maxSources, onFull? })` allows at
most `limit` attempts per key per fixed window. Every attempt counts. The
table holds at most `maxSources` keys (at least 1), and `onFull` says what a
table that is full of live windows does with a key it holds no window for:

| `onFull`               | A new key arrives when the table is full                                                                                                    | Used by                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `'refuse'` (default)   | Refused, with `retryAfterSeconds` set to the window. The table never grows and no key is admitted uncounted.                                  | The demo gate's three ceilings and the portal's support-ticket limiter.         |
| `'evict-oldest'`       | The key whose window began first is forgotten and the new key is admitted with a fresh count. The table never grows past `maxSources`.        | The portal's sign-in ceilings, which must never lock a real visitor out.       |

Under `'refuse'` a flood of distinct keys can make the service unavailable but
never unmetered. Under `'evict-oldest'` a flood of distinct keys can restart
the oldest keys' counts but never fills the table, so a visitor is not turned
away because other addresses arrived first. Choose by which failure the route
can bear: a passphrase check and a ticket flood must stay metered, a sign-in
start holds nothing worth protecting beyond the cost of the request.

`peek` reports the verdict `attempt` would give and evicts nothing under
either policy, so under `'evict-oldest'` a full table peeks as allowed;
`attempt` does the eviction. `size(nowMs)` reclaims expired windows and
returns how many keys the table holds.

## Resolving the request source

`source.ts`'s `SourceResolver.resolve` decides who is asking, for the
purpose of the attempt ceiling. The socket peer is the only fact about a
request nobody on the far side can choose. `X-Forwarded-For` is read only
when that peer is a configured trusted proxy -- the edge -- and then only
its rightmost entry, which is the address the edge itself saw; anything to
its left was written by the client. A trusted peer that sends no usable
header yields no source at all, and the caller decides what to do rather
than falling back to the proxy's own address, which would pool every visitor
into one bucket: the demo gate refuses, the portal meters such requests
under one pooled key.

An IPv6 address is keyed on its /64 (`resolve`) or its /48 (`resolveBroad`),
since one customer is routinely handed a whole block; an IPv4-mapped IPv6
address is the IPv4 address.

## `peek` and the reclaim sweep

`ceiling.ts`'s `peek` gives the verdict `attempt` would give right now,
without recording an attempt: no entry created for the key, no count
incremented. It may still evict other sources' already-expired windows when
the table looks full, the same reclaiming `attempt` itself does — without
that, a table that once reached `maxSources` would refuse every source
forever, since nothing else ever runs a sweep once every caller peeks before
it ever calls `attempt`.

For a caller checking more than one ceiling before deciding whether to
charge any of them: peek every ceiling first, and only call `attempt` on
ones that already peeked `allowed`, so a request refused by one ceiling
never creates or charges an entry in another.

The demo gate's `login()` charges both ceilings only once a request has
passed every check that comes before a derivation. A request refused earlier
-- wrong content type, unreadable or oversized body, empty or over-long
passphrase -- costs neither ceiling. Every request that reaches a derivation
costs both, including an unknown host, an unleased slot or an untied lease,
which derive against the decoy hash.

A malformed request is not free. Each of those 400 refusals is charged to a
third, separate bucket, the malformed ceiling (`GATE_CEILING_MALFORMED_ATTEMPTS`,
keyed on the same narrow source), and is answered `429` once that bucket is
spent, so a flood of them is bounded. The bucket is consulted only on those
400 paths: a well-formed attempt never reads or writes it, so a flood of
malformed requests can make further malformed requests from that source
`429`, but it can never refuse or charge a valid login.

## Why `attempt` and `peek` share one decision path

`ceiling.ts`'s `attempt` and `peek` share the whole decision function, sweep
included, so the two can never disagree about what "allowed" means. `peek`
was the regression the sweep's old home (only inside `attempt`) caused: once
a table held `maxSources` expired windows, `peek` refused every source
forever, and `login()` never reaches `attempt` on a source `peek` has
already refused, so nothing was left to reclaim them.

The sweep is safe to run from a read-only call: it only ever deletes entries
already treated as absent for every verdict, so evicting one changes no
decision, only the table's own size.

The table is kept in ascending start-time order, and two rules hold that
order: a renewed key is deleted before it is set again (`Map#set` on a key
already present keeps its old position), and `'evict-oldest'` removes the
first key, which that order makes the oldest. The sweep stops at the first
live entry on the strength of the same order.

## Tests

`pnpm run coverage` runs the unit tests with the thresholds in
`vitest.config.ts`. The ceiling's tests cover both overflow policies,
including the order invariant after an eviction, and the demo gate's tests
(which run against this package's built output) pin `'refuse'` as the default.

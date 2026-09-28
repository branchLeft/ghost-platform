# test-colour-swap.sh

## What this proves

Proves the colour-swap mechanism the drain sidecar's own contract builds
on: two real Ghost containers, one shared SQLite database, extended with
real writes during the overlap and a real swap in both directions, and
the drain flag as the one thing that ever moves traffic between them.

What this proves, against real containers:

- Booting a new colour always drains it first (this script sets each
  colour's flag before starting it, the same order
  `services/broker/src/app.ts`'s `attemptColourSwap` always uses).
- A swap in each order (a->b and b->a) moves continuous requests to
  exactly one version at a time, with none failing.
- Swap latency: time from the flag change to the sidecar reporting it,
  polled at the same 2s interval the real edge uses.
- SQLite behaviour under concurrent requests against both colours'
  shared file during the overlap, counted -- read-path only (see
  [SQLite contention caveat](#sqlite-contention-caveat): no authenticated
  write path is fixtured here, so this does not yet prove genuine write
  contention).
- Sabotage, distinct from the drain sidecar's own sabotage: with both
  colours' flags cleared at once, both answer 200 -- proven directly
  against each colour's own sidecar, since this script does not run a
  real Caddy/router. The edge's own routing behaviour for this exact
  topology is measured separately.

## SQLite contention caveat

This repo's authenticated write paths all need an Admin API session or a
configured mail transport this throwaway fixture does not set up, so
every request below is refused by Ghost's own auth middleware (401/400)
before it reaches SQLite at all -- it measures concurrent *read-path*
throughput against the shared file (both colours' boot-time migrations
and queries), not a genuine write race. A real authenticated-write
contention run is separate, discovered work; reporting "0 busy errors"
from requests that never wrote anything would be a false-negative result,
so this prints what was actually measured rather than a number that looks
like the Done-means bullet but isn't.

# spawnBroker.ts

## ensureBuilt

The proof this whole file exists for has to run against the actual built
entrypoint (`dist/server.js`), not against `src/server.ts` imported
in-process — an in-process import proves the wiring function, never that
`node dist/server.js` (what a real deploy runs) behaves the same way.

Rebuilds whenever `dist/server.js` is missing *or* older than the newest
file under `src/` — not merely missing. A build that exists but predates
the latest edit is exactly the shape a sabotage-then-test cycle produces
locally: `dist/` from a clean tree, `src/` edited afterwards, and an
`existsSync`-only check would run the stale JS and report the sabotage's
regression test green. The CI workflow's explicit build step means every
check here is a no-op there (a build that just ran is never older than its
own source).

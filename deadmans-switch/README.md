# @branchleft/ghost-platform-deadmans-switch

The estate's dead-man's switch for drain workers: one small module that pings
Healthchecks once per period in which every expected target has completed a
poll cycle. It never pings on a timer of its own, because a timer keeps ticking
while the loop is wedged.

Consumers depend on it through a relative `link:` dependency, the same pattern
as `services/demo-gate` and `render-core`:

- `services/mail-collector` (the drain worker).

The collector's semantics, the proof, and the sabotage control are documented in
`services/mail-collector/README.md` (the heartbeat sections) and
`services/mail-collector/docker-proof/deadmans-switch/proof-harness.md`.

Build and test in this directory, with the repo's pinned pnpm:

    pnpm install --frozen-lockfile
    pnpm run build
    pnpm run test:unit

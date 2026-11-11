# proof-harness.mjs

## What this drives

Drives the real, built `createDeadMansSwitch` from the shared package
`@branchleft/ghost-platform-deadmans-switch` (its `dist/`, produced by
`pnpm run build` from `deadmans-switch/src/heartbeat.ts` -- not a
reimplementation) against a real local Healthchecks instance, to prove the
dead man's switch:

- idle (no drain activity, only completed empty cycles): stays "up"
- killed once and restarted within the grace window: never "down"
- stopped (nothing calls `onCycleComplete()` again): "up" -> "grace"
  ("Late") -> "down"

Every status is asserted. A wrong state prints `FAIL` and exits non-zero, so
the proof can fail; it is not a log for a human to read.

Run from `services/mail-collector/` after `pnpm run build`, with the
healthchecks container already up (`docker-compose.deadmans-switch-proof.yml`)
and `PROOF_*` env vars exported by `docker-proof/deadmans-switch/hc_setup.py`'s
output. Never run against a production Healthchecks URL -- see
`deadmans-switch/src/heartbeat.ts`'s own doc comment on why a ping is
fire-and-forget either way.

# proof-harness.mjs

## What this drives

Drives the real, built `createDeadMansSwitch` (`dist/heartbeat.js`, produced
by `npm run build` from `src/heartbeat.ts` — not a reimplementation) against
a real local Healthchecks instance, to prove the dead man's switch:

- idle (no drain activity, only completed empty cycles): stays "up"
- stopped (nothing calls `onCycleComplete()` again): "up" -> "grace"
  ("Late") -> "down"
- killed once and restarted within the grace window: never "down"

Run from `services/mail-collector/` after `npm run build`, with the
healthchecks container already up (`docker-compose.deadmans-switch-proof.yml`)
and `PROOF_*` env vars exported by `docker-proof/deadmans-switch/hc_setup.py`'s
output. Never run against a production Healthchecks URL — see
`src/heartbeat.ts`'s own doc comment on why a ping is fire-and-forget either
way.

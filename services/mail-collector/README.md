# mail-collector

The drain worker (LLD-6, HLD §02/§03): holds a drain connection into every
host the tenant/demo descriptor names, delivers each drained message over
authenticated SMTP submission, and acks it back. See
`ghost-platform-docs/19-try-it-now-design/06-mail-delivery.html`.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no (default `8080`) | This process's own `/healthz` port. |
| `COLLECTOR_DESCRIPTOR_DIR` | yes | Directory of tenant/demo descriptor JSON files — the only source of the drain list. |
| `COLLECTOR_DESCRIPTOR_REFRESH_MS` | no (default `5000`) | How often the descriptor directory is re-read. |
| `COLLECTOR_DESCRIPTOR_MAX_STALENESS_MS` | no (default `60000`) | Past this age, the drain list is treated as empty rather than as its last good read. |
| `COLLECTOR_SHIM_PORT` | no (default `8080`) | The HTTP port every host's mailgun-shim listens on for its drain surface — a deployment convention, combined with the descriptor's own `appHostIp`. |
| `COLLECTOR_DRAIN_TOKEN` | yes | The drain endpoint's shared bearer credential. One value across every host today — see the PR body's Design section for why, and what changes once per-host tokens exist. |
| `COLLECTOR_DRAIN_TIMEOUT_MS` | no (default `40000`) | Client-side timeout for one `GET /drain` call. Must exceed the target shim's own `SHIM_DRAIN_HOLD_MS`. |
| `COLLECTOR_DRAIN_RETRY_BACKOFF_MS` | no (default `2000`) | Backoff after a failed drain/ack call to one host before retrying it. |
| `COLLECTOR_EMPTY_POLL_BACKOFF_MS` | no (default `250`) | Backoff after a `GET /drain` that answered with zero messages, before polling that host again. |
| `COLLECTOR_MESSAGES_PER_HOUR` | no (default `50`) | The estate-wide send-rate ceiling, moved here from the shim's per-spool bucket. |
| `COLLECTOR_THROTTLE_CONFIG_PATH` | no | Optional live-reloadable override file, `{"messagesPerHour": N}`. |
| `COLLECTOR_DEDUPE_TTL_MS` | no (default `3600000`) | How long a delivered message id is remembered, to recognise a re-offer caused by a lost ack. |
| `COLLECTOR_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | yes / no (`587`) / yes / yes | mx1's authenticated SMTP submission endpoint. |
| `COLLECTOR_SMTP_SECURE` | no (default `false`) | `true` for implicit TLS. |
| `COLLECTOR_HEARTBEAT_URL` | yes | The estate's dead-man's-switch URL (Healthchecks.io, or the local instance standing in for it in proof). Pinged only once **every** descriptor-named host has completed a successful cycle since the last ping — never on a timer of this process's own, which would keep firing while one host is wedged. An empty poll (zero mail) counts as a success; a drain failure or a wedged host against any one target withholds that target's report and silences the whole switch until it recovers. With zero live targets (no tenant/demo descriptor currently exists), the switch withholds every ping by the same rule — deliberately: "zero hosts pages me". Suppressed while `COLLECTOR_HEARTBEAT_FAILURE_THRESHOLD` consecutive deliveries have failed. |
| `COLLECTOR_HEARTBEAT_FAILURE_THRESHOLD` | no (default `5`) | Consecutive delivery (SMTP submission) failures that suppress the heartbeat ping — a collector whose loop keeps turning over but cannot submit anything must go silent too. Resets on the next successful delivery. |

## Design

See the delivering PR's body for the drain-list-derivation and
estate-wide-throttle design decisions; this file states only the mechanics
env vars need, not the reasoning, which is load-bearing enough to live
where it can't drift from the code that implements it (inline, in
`src/descriptorTargets.ts` and `src/throttle.ts`).

`docker-proof/deadmans-switch/run-deadmans-switch-proof.sh` proves
`src/heartbeat.ts` against a real local Healthchecks instance rather than
a mock — see its own header comment and the delivering PR's body for a
recorded run.

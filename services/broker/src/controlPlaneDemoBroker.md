# controlPlaneDemoBroker.ts

## createTunnelBroker

The control plane's signed calls to the demo host's broker: `reconcile`,
`status` and `reset`, over the tunnel ops1 dials to demo1. The demo estate
never initiates (LLD-2 section 06): this is the only direction a call goes.

`baseUrl` is the tunnel's local end and is refused unless it is http(s) on
loopback or a private IPv4 address (`TunnelAddressError`), so the signing key
can never be sent to an address a public resolver answers.

Each POST is signed over the exact bytes sent (method, path, timestamp, nonce,
body) with a fresh nonce, so sending the same reconcile again is a new,
valid request carrying an identical descriptor, which the broker recognises on
(slot, descriptor hash) and does not repeat. Redirects are never followed.

The replies are closed sets, not response bodies:

- `reconcile`: `running` (200 with the documented body, nothing else counts),
  `failed` (503 with phase `error`: the broker's own reset-and-retry-once is
  spent), `refused` (every other answer, final), `unanswered` (no answer in
  the deadline: it may or may not have run, and sending it again is safe).
- `reset`: `free`, `refused` or `unanswered`.
- `status`: the phase and the per-colour health answer, or `undefined` when the
  host gave no usable answer. `GET /status` is unauthenticated by design.

A host's words never reach a prospect: nothing here returns an error message.

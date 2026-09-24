# odask

Caddy's `on_demand_tls` ask endpoint: `GET /?domain=<sni>`, once per new
hostname, before Caddy orders anything. See
`ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html` §02 (E1-E5)
and §06's decisions table for the design this implements.

- `200` if `domain` is served by a tenant descriptor in `DESCRIPTOR_DIR`.
- `400` if `domain` is missing or not syntactically a hostname.
- `403` if `domain` is well-formed but unserved, and the per-source ceiling
  (below) has room.
- `429` if `domain` is unserved and the ceiling is exhausted.

A `200` admits the handshake. Every other status refuses it and, on Caddy's
side, the handshake simply fails — there is no HTTP status at all, because
nothing beyond this endpoint is ever reached (LLD-5 E1).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `BIND_HOST` | yes, no default | The interface this process binds to. No fallback: an unset value fails closed rather than defaulting to every interface (LLD-5 E2 — Caddy sends no credential, so this service's only defence is its network position). |
| `DESCRIPTOR_DIR` | yes, no default | Directory of one JSON tenant descriptor per file. |
| `BASE_DOMAIN` | yes, no default | This edge's own base domain, e.g. `sites.publicpress.co.uk`, used to expand a descriptor's `hostname.kind === "ours"` `sub` into the hostname Caddy asks about. |
| `PORT` | no (`9000`) | |
| `REFRESH_INTERVAL_MS` | no (`5000`) | How often the descriptor directory is re-read. |
| `RATE_LIMIT_CAPACITY` | no (`50`) | Token bucket capacity for unknown-hostname requests. |
| `RATE_LIMIT_REFILL_PER_SECOND` | no (`10`) | Token bucket refill rate. |

The ceiling (`RATE_LIMIT_*`) is a single global bucket, applied only to
misses — a served hostname is never throttled, and Caddy no longer
throttles on-demand issuance itself at all (LLD-5 E3), so this is the only
ceiling there is.

## Testing

```bash
npm ci
npm run typecheck
npm run coverage   # unit + a real-socket reachability test, threshold 90%
```

The real-socket reachability test (`test/integration/reachability.test.ts`)
proves the network-position claim above against actual sockets rather than
a mock: bound to one interface, unreachable from another, with a permanent
control case proving that same interface *is* reachable when bound to
`0.0.0.0` — a network fluke can't fake that asymmetry.

## Live proof

```bash
docker build -f services/odask/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t odask:local .
./scripts/test-odask.sh odask:local
```

Boots a real Caddy with `on_demand_tls` pointed at the image under test, a
real ACME test CA (Let's Encrypt's Pebble, run through the actual ACME v2
protocol — order, HTTP-01 challenge, finalize, download), and
`pebble-challtestsrv` as a DNS stub. Proves: a served hostname completes
the handshake and is issued a real Pebble-signed certificate; a disallowed
hostname's handshake fails outright, with no HTTP status and nothing
logged about it; the ask endpoint's own four-way status contract; and that
a burst of distinct unknown names trips the ceiling.

`NODE_AUTH_TOKEN` needs `packages:read` on GitHub Packages —
`@branchleft/tsconfig` is a build-time dependency hosted there.

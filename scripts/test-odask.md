# test-odask.sh

## What this proves

Proves the on-demand TLS ask endpoint's contract live: a real Caddy with
`on_demand_tls` in front of it, asking before every issuance, and a real
ACME test CA (Let's Encrypt's own Pebble, run through the actual ACME v2
protocol -- order, authorization, HTTP-01 challenge, finalize, download)
rather than Caddy's built-in internal CA. Design:
`ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html` §02
(E1-E5).

What it shows, each against the real edge rather than the service alone:

- a served hostname completes the TLS handshake and Pebble genuinely
  issues it a certificate (the leaf's issuer is a Pebble Intermediate CA,
  not Caddy's own `local_certs` authority)
- an unserved hostname never gets that far: the handshake itself fails,
  with no HTTP status at all on Caddy's side (LLD-5 E1) -- proven by a
  failed TLS connect, not a 4xx response, because there is no response to
  have a status
- the ask endpoint's own contract holds when queried directly: 200 for
  served, 403 for unserved-under-the-ceiling, 429 once a burst of distinct
  unknown names exceeds it (LLD-5 E3), 400 for a malformed domain
  parameter
- Caddy's own log shows an issuance attempt for the served hostname and
  none at all for the refused one -- the ask happens before Caddy would
  even try

Pebble's validation authority is configured `PEBBLE_VA_ALWAYS_VALID=0` (the
default): it performs a real HTTP-01 challenge round-trip against this
Caddy, resolved through `pebble-challtestsrv`'s fake DNS (every name
defaults to the Caddy container's address -- there is no real DNS zone for
the fixture hostnames, nor does this proof need one).

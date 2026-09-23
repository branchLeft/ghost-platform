# demo-gate

The demo edge's admission service: a Caddy `forward_auth` target that checks
a gated slot's `argon2id` passphrase under a per-source attempt ceiling and a
bounded derivation cap, and issues a signed cookie naming the slot and the
lease it was issued against. See
`ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html` §03 for the
placement this implements, and `proof/Caddyfile` /
`scripts/test-demo-gate.sh` for the smallest edge that exercises the same
contract.

It authenticates a lease, never a person: no account, no personal data ever
enters the cookie.

## Endpoints

- `GET`/`HEAD /__gate/verify` — the `forward_auth` target. `200` only when a
  request cookie names the host's current slot and its current lease;
  everything else, including any internal error, is a non-2xx.
- `POST /__gate/login` — the passphrase form's target. Always derives
  exactly one `argon2id` hash per request (the slot's hash on a leased,
  known host; a fixed decoy otherwise), so a guess against an unknown host
  costs the same as one against a real slot. `303` with the cookie on a
  match, `401` on anything else, `429` past the per-source ceiling, `503`
  past the derivation cap.

## Environment contract

No default admits: the three inputs that decide who is admitted have none,
and an unset value refuses to start rather than guessing.

| Variable                      | Required | Default       | Notes                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GATE_SIGNING_KEY_FILE`       | yes      | —             | Path to the HMAC-SHA256 signing key, ≥32 bytes. Read from a file so the key never enters the process environment.                                                                                                                                                                                       |
| `GATE_SLOTS_FILE`             | yes      | —             | Path to the slots file (below). Re-read on every request; a parse is reused only while the file's bytes are unchanged.                                                                                                                                                                                  |
| `GATE_LEASE_DIR`              | yes      | —             | Directory of per-slot lease records (below). Read fresh on every request — never cached — so a new lease invalidates every cookie issued against the old one at once.                                                                                                                                   |
| `GATE_TRUSTED_PROXIES`        | no       | `` (none)     | Comma-separated addresses/CIDRs. `X-Forwarded-For` is honoured only from a listed peer, and only its rightmost entry. With none listed, the source is always the socket peer.                                                                                                                           |
| `GATE_COOKIE_TTL_SECONDS`     | no       | `43200` (12h) | Bounded `1`–`604800` (7d).                                                                                                                                                                                                                                                                              |
| `GATE_CEILING_ATTEMPTS`       | no       | `10`          | Attempts per source per window before `429`. Bounded `1`–`1000`. Counts every attempt, right or wrong.                                                                                                                                                                                                  |
| `GATE_CEILING_WINDOW_SECONDS` | no       | `900`         | Bounded `1`–`86400`.                                                                                                                                                                                                                                                                                    |
| `GATE_CEILING_MAX_SOURCES`    | no       | `100000`      | Live per-source windows the ceiling's table holds at once. Bounded `1`–`10000000`; a new source is refused once it's full rather than admitted uncounted.                                                                                                                                               |
| `GATE_ARGON2_MAX_CONCURRENT`  | no       | `4`           | Argon2id derivations allowed in flight at once, across every source together — bounds aggregate cost the per-source ceiling doesn't. Bounded `1`–`64`; the default matches Node's own libuv threadpool size, since a higher cap here would only grow a second queue behind the one libuv already keeps. |
| `GATE_ARGON2_MAX_QUEUED`      | no       | `64`          | Waiters past the concurrency cap before a login is refused with `503` rather than queued without limit. Bounded `1`–`10000`.                                                                                                                                                                            |
| `PORT`                        | no       | `8080`        | Bounded `1`–`65535`.                                                                                                                                                                                                                                                                                    |
| `LISTEN_HOST`                 | no       | `127.0.0.1`   | Set to `0.0.0.0` in the container image; the address only the edge can reach it on is the operator's decision.                                                                                                                                                                                          |

## The signing key file

The container runs as `node` — uid 1000, the user baked into the
`node:*-bookworm-slim` base image (`USER node` in the Dockerfile). It never
runs as root. A real host gives the key file to the gate's own uid, **mode
`0400`**: readable by the gate and nobody else, not even its own group.
`scripts/test-demo-gate.sh` mounts a throwaway key world-readable instead,
because its fixtures are disposable and the point there is the contract, not
the file's permissions.

## The slots file

```json
{
  "slots": [
    {
      "host": "a1b2.demo.example",
      "slot": "0",
      "gate": { "kind": "passphrase", "argon2idHash": "$argon2id$v=19$m=65536,t=3,p=4$..." }
    }
  ]
}
```

One entry per gated host. `slot` and `host` must each be unique across the
file; `gate.kind` must be `"passphrase"` — a `"none"` gate reaching this
service is a rendering mistake upstream, since every host sent here is gated
by definition, and admitting on it would open the host rather than refuse
it. The whole file is parsed or the whole file is refused: one malformed
entry never leaves the others half-loaded. Capped at 256 KiB.

## The lease directory

One file per slot, named `<slot>.json`, written by the broker on reconcile
and reset (`render-core`'s `leaseRecordFileName`/`parseSlotLeaseRecord` — the
same functions and the same on-disk record the mail spool purges on at
recycle, LLD-6 M7):

```json
{ "slot": "0", "lease": "01J9F4Q7ZC3M8V2K6X0R5T1B9D" }
```

The reader opens with `O_NOFOLLOW`: a symlink where a record should be is
not a record. Any failure to read or parse it — missing, unreadable,
malformed, a symlink — is treated as "no current lease", and every caller
denies rather than falling back to an earlier answer. The broker writes the
record beside its final name and renames it into place, so a reader never
sees a half-written file.

## Minting a hash

`node dist/hashCli.js` reads a passphrase on stdin and writes its
`argon2id` PHC string to stdout, at `DEFAULT_PARAMETERS` (RFC 9106's second
recommended option: 64 MiB, 3 passes, 4-way parallel). It never touches the
slots file or the lease directory — the descriptor is rendered from its
output, not the other way round.

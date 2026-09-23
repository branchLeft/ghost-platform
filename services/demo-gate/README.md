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
  exactly one `argon2id` hash per request (the slot's hash when the lease
  just read is tied to it -- see "The recycle contract" below -- a fixed
  decoy otherwise), so a guess against an unknown host, an untied pair, or
  an unleased slot all cost the same as one against a real, current
  tenancy. `303` with the cookie on a match, `401` on anything else, `429`
  past either attempt ceiling, `503` past the derivation cap.

## Environment contract

No default admits: the three inputs that decide who is admitted have none,
and an unset value refuses to start rather than guessing.

| Variable                         | Required | Default       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | -------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GATE_SIGNING_KEY_FILE`          | yes      | —             | Path to the HMAC-SHA256 signing key, ≥32 bytes. Read from a file so the key never enters the process environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GATE_SLOTS_FILE`                | yes      | —             | Path to the slots file (below). Re-read on every request; a parse is reused only while the file's bytes are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GATE_LEASE_DIR`                 | yes      | —             | Directory of per-slot lease records (below). Read fresh on every request — never cached — so a new lease invalidates every cookie issued against the old one at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GATE_TRUSTED_PROXIES`           | no       | `` (none)     | Comma-separated addresses/CIDRs. `X-Forwarded-For` is honoured only from a listed peer, and only its rightmost entry. With none listed, the source is always the socket peer. **An edge story behind this gate must set it** — see "A trusted-proxy list left empty" below.                                                                                                                                                                                                                                                                                                                                                               |
| `GATE_COOKIE_TTL_SECONDS`        | no       | `43200` (12h) | Bounded `1`–`604800` (7d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GATE_CEILING_ATTEMPTS`          | no       | `10`          | Attempts per source (IPv6 /64, or the IPv4 address) per window before `429`. Bounded `1`–`1000`. Counts every attempt, right or wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GATE_CEILING_WINDOW_SECONDS`    | no       | `900`         | Shared by both ceilings below. Bounded `1`–`86400`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GATE_CEILING_MAX_SOURCES`       | no       | `100000`      | Live per-source windows the narrow ceiling's table holds at once. Bounded `1`–`10000000`; a new source is refused once it's full rather than admitted uncounted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GATE_CEILING_BROAD_ATTEMPTS`    | no       | `200`         | A second, coarser ceiling: attempts per IPv6 /48 (or the same IPv4 address `GATE_CEILING_ATTEMPTS` already keys on) per window. Bounded `1`–`20000`. Catches a flood spread across many /64s inside one /48, which the narrow ceiling alone cannot see in aggregate.                                                                                                                                                                                                                                                                                                                                                                      |
| `GATE_CEILING_BROAD_MAX_SOURCES` | no       | `20000`       | Bounded `1`–`2000000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GATE_ARGON2_MAX_CONCURRENT`     | no       | `3`           | Argon2id derivations allowed in flight at once, across every source together — bounds aggregate cost neither ceiling above does. Bounded `1`–`64`. **Keep this below the process's libuv threadpool size** (Node's own default is 4; `UV_THREADPOOL_SIZE` if it is ever changed) — `crypto.argon2` and `fs` share that pool, and `verify` runs on every forward_auth, so saturating the pool with derivations starves every page and asset behind the gate. Measured at the default cap of 4 (equal to the pool): a 112 ms median, 130 ms max added to `verify`'s own file reads under a full queue, against 0.3 ms/1.8 ms at a cap of 3. |
| `GATE_ARGON2_MAX_QUEUED`         | no       | `64`          | Waiters past the concurrency cap before a login is refused with `503` (the ceiling attempt it already spent is refunded, not left to count against it) rather than queued without limit. Bounded `1`–`10000`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PORT`                           | no       | `8080`        | Bounded `1`–`65535`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LISTEN_HOST`                    | no       | `127.0.0.1`   | Set to `0.0.0.0` in the container image; the address only the edge can reach it on is the operator's decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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
{ "slot": "0", "lease": "01J9F4Q7ZC3M8V2K6X0R5T1B9D", "hashId": "b13f00734cd8ad07" }
```

The reader opens with `O_NOFOLLOW`: a symlink where a record should be is
not a record. Any failure to read or parse it — missing, unreadable,
malformed, a symlink — is treated as "no current lease", and every caller
denies rather than falling back to an earlier answer. The broker writes the
record beside its final name and renames it into place, so a reader never
sees a half-written file.

## The recycle contract

`slots.json` (the hash) and a slot's lease record are two files the broker
writes independently, at different moments, with no shared transaction
between the two writes. `login()` reads both on every attempt, so a hash
and a lease read a moment apart can belong to two different tenancies
unless the broker honours this contract (adversarial review, PR
branchLeft/ghost-platform#236 cycle 1, finding 1 — reproduced as a
regression test against the real file-backed readers in
`test/unit/app.test.ts`, "the recycle race"):

1. **The slot's `argon2id` hash must be replaced on every recycle.** A
   lease that outlives the passphrase it was issued under is not a recycle
   at all — the previous visitor, and anyone they shared the passphrase
   with, simply logs in again. Nothing downstream of the broker can detect
   an unrotated hash; this is broker discipline, not a checkable invariant.
2. **Every lease record the broker writes on recycle must carry
   `hashIdOf(the hash it just wrote for this tenancy)`**
   (`render-core`'s own function — the broker must compute it the exact
   same way, not re-derive it). `login()` admits only when the lease
   record's `hashId` matches the hash actually in hand; an untied pair is
   refused exactly like no lease at all, never derived against. This is
   what makes the check correct regardless of which file the broker
   happens to write first, or how a read lands relative to either write —
   unlike trusting a write order, which only holds if the broker's actual
   order matches what was assumed.

## Minting a hash

`node dist/hashCli.js` reads a passphrase on stdin and writes its
`argon2id` PHC string to stdout, at `DEFAULT_PARAMETERS` (RFC 9106's second
recommended option: 64 MiB, 3 passes, 4-way parallel). It never touches the
slots file or the lease directory — the descriptor is rendered from its
output, not the other way round.

## A trusted-proxy list left empty

`GATE_TRUSTED_PROXIES` unset behind a real edge pools every visitor into
Caddy's own address — the per-source ceilings above would then count the
whole demo estate's traffic as one source, refusing everyone once any of
it trips the limit. Setting it is the edge story's responsibility
([ISSUE branchLeft/workspace#1254](https://github.com/branchLeft/workspace/issues/1254)),
not something this service can default its way out of: it has no way to
know which peer address is really the edge.

## The derivation concurrency cap (design amendment)

LLD-5 does not mention argon2id derivation concurrency; the cap in
`src/derivationGate.ts` and `GATE_ARGON2_MAX_CONCURRENT` above is an
incidental amendment, recorded in `ghost-platform-docs`'s
`19-try-it-now-design/05-gate-and-edge.html` under a dated note. It bounds
a _count_, not memory directly — a slot's hash may ask for up to 256 MiB
(`argon2id.ts`'s `LIMITS.memoryKiB`), so the real ceiling on live
derivation memory is the concurrency cap times 256 MiB: 768 MiB at the
default of 3, 16 GiB at the configurable maximum of 64.

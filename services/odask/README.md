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

## Source notes

One section per symbol whose source comment was trimmed to a pointer here.

### app createApp

The one route Caddy's `on_demand_tls { ask ... }` calls, once per new SNI,
before it orders anything: `GET /?domain=<sni>`. `200` admits the name;
any other status refuses it and the handshake fails with no HTTP status
at all on Caddy's side (LLD-5 E1) — so every refusal path here can pick
whichever non-2xx status is clearest for the service's own logs without
changing what Caddy does with it.

Fails closed by construction: every branch that is not the single
"hostname is in the served set" branch ends in a non-200 response, and
there is no branch that falls through without setting a status.

### config bindHost

No default: an unset value would leave the process free to fall back to
every interface, which is exactly the failure this config exists to make
impossible to reach by accident (LLD-5 E2 — the ask endpoint is therefore
only as safe as its network position). A wildcard value (`0.0.0.0`, `::`,
`[::]`) is refused for the same reason: it is not an unset value, but it
produces the identical failure — reachable from every interface — so
refusing it here is the load-bearing half of the story's own
done-means control case: bind it to all interfaces and the reachability
test goes red.

### descriptorStore hasValidShapeForServing

A minimal, local shape check — not render-core's `validate()`. `validate`
enforces cross-field invariants that are the harness's job to have
already run before a descriptor reaches this directory (LLD-5 §07
handoff: the harness gains a further gate). Re-running the full check
here would duplicate that gate and give this service an opinion on
fields it never reads. What this service needs is narrower and load-
bearing on its own: is the descriptor shaped enough for render-core's
`servedHostnameOf` to read `kind` and `hostname` at all, so a corrupt or
half-written file is excluded from the served set rather than crashing
the refresh or being read as some other variant's fields.

### descriptorStore DescriptorStore

The in-memory served-hostname set an ask asks against, refreshed from a
directory of one JSON descriptor file per tenant. A negative answer costs
no read of anything (LLD-5 E3): `has()` only ever touches the `Set`
`refresh()` last built, never the filesystem or a per-request query.

Which hostname a descriptor derives to — and which descriptors must
never be served at all — is render-core's `servedHostnameOf`, not a copy
of it: a second implementation of that logic is exactly how it diverged
the first time.

### descriptorStore refresh

Rebuilds the served set from the directory, atomically from a caller's
point of view: `has()` keeps answering from the previous set until this
completes, and a directory read failure leaves the previous set intact
rather than clearing it — up to `maxStalenessMs`, past which `has()`
fails closed on its own regardless of what `served` still holds. A
per-file parse or shape failure is narrower: that one file is excluded
and the refresh continues.

A second call while one is already running joins the first rather than
starting a competing read. Not `async`, deliberately: an `async`
function always wraps its return value in a *new* Promise, even when the
body returns an existing one — which would make two overlapping callers
each hold a different Promise object for the same underlying read,
defeating the point of joining.

### hostname isEveryInterfaceAddress

Whether `address` is what Node's `net` module actually binds an "every
interface" request to, once `listen()` has succeeded — not what an
operator typed. `0`, `0.0.0.0`, `::0` and `0::` normalise to exactly
`0.0.0.0` or `::` in `server.address().address` on every platform
measured (macOS, Linux). `::ffff:0.0.0.0` (an IPv4-mapped IPv6 address)
does the same on macOS, but on Linux it reports back as the literal
string `::ffff:0.0.0.0` rather than collapsing to `::` — measured
directly against the Node base image this service ships on, after CI
(Ubuntu) caught the gap a macOS-only measurement missed. All equivalent
IPv4-mapped spellings (`::ffff:0:0`, the fully-expanded form, mixed case)
collapse to that same one string on Linux, so three literals are the
complete set, not the start of an enumeration. The set of spellings an
operator could type is unbounded; the kernel's own answer,
platform-normalised, is not — `config.ts`'s string check on `BIND_HOST`
itself is only ever a fast, friendly early error for the spellings it
happens to list, never the real guard. `server.ts` checks this
function's answer against the real bound address after `listen()`.

### rateLimiter TokenBucket

A single global token bucket, applied only to requests for a hostname the
served set does not contain (LLD-5 E3: Caddy's own on-demand-issuance
throttle no longer exists, so the ceiling moves into this service). A
served hostname is never throttled — it is a legitimate, bounded-cost
`Set.has()` regardless of rate.

The bucket is two numbers (`tokens`, `lastRefillMs`), not a per-hostname
or per-source map: a burst of many *different* unknown names costs the
same one decrement each, so nothing here grows with how many distinct
names an attacker tries — refused without growing memory, not merely
refused behind a large enough cap.

### reachability test load-bearing control

The load-bearing control (LLD-5 E2, and the story's own done-means: bind
it to all interfaces and the reachability test goes red). This spawns
the actual built entrypoint (`dist/server.js`, built by this package's
`pretest:unit`/`precoverage` hooks) with real environment variables —
not `createApp(...).listen(...)` called directly from the test process —
because the property under test is what the shipped process does with
`config.bindHost`, and a local listen helper cannot see a bug in
`server.ts`'s own wiring between the two.

A non-loopback IPv4 address is what a multi-homed edge host has beyond
its private interface: something with a route to it that is not the
interface odask is supposed to be reachable on. `127.0.0.2` was tried
first and rejected — unlike Linux, macOS does not route the rest of
`127.0.0.0/8` to loopback without an explicit interface alias, so a
connection to it hangs (`ETIMEDOUT`) rather than proving anything. The
machine's real, already-configured interface has no such platform gap.

How to reproduce this test's sabotage case (recorded verbatim in the
delivering PR's body): in `src/server.ts`, change
`app.listen(config.port, config.bindHost, () => { ... })` to
`app.listen(config.port, config.bindHost && '::', () => { ... })`, then
`npm run build` and re-run this file. `config.bindHost` is always a
non-empty string (`config.ts` throws otherwise), so the `&&` is a no-op
in disguise — every request still reads as "bound to `config.bindHost`"
in a log line or a config dump, while the process actually binds every
interface.

A second sabotage the second `describe` block below guards, the same
way: delete the post-listen `isEveryInterfaceAddress` check in
`server.ts` entirely. `BIND_HOST=0.0.0.0` is still refused (`config.ts`'s
own string check), but `BIND_HOST=0` — and `::0`, `0::`,
`::ffff:0.0.0.0` — are not spellings that check lists, so with the
post-listen guard gone all four start, bind every interface, and this
suite is what notices.

### server test wiring

`server.ts` is excluded from coverage (`vitest.config.ts`) because it is
a process entrypoint — reading real env vars, starting a real timer,
wiring real signal handlers — none of which is unit-testable without
starting an actual OS process. `reachability.test.ts` covers the
*behaviour* this file's binding call produces by spawning the real built
`dist/server.js`. This test covers the *source* directly, as a fast,
no-build-required first line of defence: it fails on any rewrite of the
one `.listen()` call site's host argument, including one whose behaviour
a reachability test would still have to actually run a process and open
a socket to notice.

# The verdict channel host end

## What it is

A small process on a demo or tenant host. The scanning decorator writes PDQ
hashes to it over a local unix socket (`../src/verdict-socket.md`). The safety
service, which holds the hash-source credential, dials in over HTTP and drains
the queue. **The host answers; it never calls.** The wire contract is
`docs/verdict-channel.md` in `branchLeft/content-safety`, version 1, and this
process implements its host side.

```
decorator --unix socket--> [ local socket | queue (journal) | inbound HTTP ] <--dials-- safety service
```

Start it with `node verdict-host/main.js`. Settings come from the environment,
read once at start; a missing or malformed value stops the process with a
message naming the variable.

| Variable | Meaning |
| --- | --- |
| `VERDICT_HOST_SOCKET` | Absolute path of the local unix socket. |
| `VERDICT_HOST_SOCKET_MODE` | Three octal digits, default `600`. |
| `VERDICT_HOST_JOURNAL` | Absolute path of the queue journal. |
| `VERDICT_HOST_VERIFY_KEY_FILE` | Absolute path of the service's public key: base64 of 32 bytes, the form the channel key role prints. |
| `VERDICT_HOST_METRICS_FILE` | Absolute path, ending `.prom`, for the collector's textfile. |
| `VERDICT_HOST_INBOUND_PORT` | Port the safety service dials, 1 to 65535. |
| `VERDICT_HOST_INBOUND_HOST` | Loopback address only, default `127.0.0.1`. |
| `..._HOLD_MS`, `..._LEASE_MS`, `..._REOFFER_DELAY_MS`, `..._VERDICT_TTL_MS`, `..._ASK_WAIT_MS`, `..._MAX_QUEUED`, `..._REPLAY_WINDOW_SECONDS` | Limits, defaults below. |

## The local socket

Created `0600` from the instant it exists, then set to the configured mode. A
stale socket from a run that was killed is replaced; anything at the path that
is not a socket stops the start. At most 64 connections, one ask each, one line
of at most 1024 bytes read within 2 seconds, else the connection is dropped.
The host end waits `ASK_WAIT_MS` (default 1 second, under the client's budget)
for a verdict and then replies `unavailable`; the hash stays queued. A verdict
that arrives later is kept for `VERDICT_TTL_MS` (default 10 minutes), so the
decorator's next ask for the same hash is answered at once and a held upload
can be promoted.

## The queue

An append-only journal, `0600`, in a `0700` directory, replayed at start and
rewritten small. Every queued hash and every verdict is synced before the
call returns. If the journal cannot be written the ask is refused rather than
accepted, so a hash is never "queued" without being on disk. A restart loses
nothing that was waiting, and the age of a waiting hash carries across it. A
half-written last record is dropped and a damaged one skipped, with a count
logged. The queue holds at most 10,000 hashes; past that an ask is refused
(`busy`).

## The inbound end

`GET /safety/v1/pending` and `POST /safety/v1/verdicts`, nothing else; any other
path, a query string or a method gets 404. Plain HTTP on a loopback address
only: a host end that must be reached from another machine sits behind a TLS
terminator, as the service accepts plain `http` only for loopback.

- **Who may call.** Every request carries the broker's three signed-request
  headers. Checks run in this order, and the order is a control: format, the
  replay window (60 seconds back, 5 forward, nothing at or before the process
  start), the Ed25519 signature over `METHOD\nPATH\nTIMESTAMP\nNONCE\n` and the
  body, and only then the nonce claim, so a forged request cannot burn the real
  signer's nonce. Refusal is 401 with no body and a fixed reason in the log.
- **Bounds.** Bodies are read byte by byte and cut off at 262144 (413). Headers
  and body must arrive within 10 seconds. At most 32 connections and 4 held
  polls at once (a fifth gets 503).
- **The poll.** Held up to 30 seconds. It answers with at most 500 hashes under
  a fresh batch name, or an empty list. A caller that goes away is not served.
  A batch is a lease of 120 seconds.
- **The verdicts.** A batch is answered once. 204 takes it; 409 means the lease
  is over or the batch is unknown; 400 means the body did not read. The reader
  is strict: a wrong version, a missing or extra field, or one bad entry makes
  the whole body unreadable, and an unreadable body settles nothing.
- **What settles a hash.** A match (`csam`, `harmful-abusive-material`, `test`)
  settles it. `no-known-match` settles it only when the service also allowed
  it. Everything else, `unavailable` and every hold included, settles nothing:
  the hash returns to the queue and is offered again after 30 seconds. A hash
  the body does not name, or names twice, is treated the same.
- **Silence is never a pass.** The decorator holds an upload on any reply that
  is not a clean verdict.

`verdicts-body.js` is a port of the strict reader in `content-safety`
(`src/verdict-schema.ts`), which the contract says a host runs. It is a port
because that package is private and TypeScript, and this one is a Ghost image
dependency in CommonJS. It reads the same field sets; a change to the contract
must change both. The signed-request check is likewise a port of the platform
broker's (`services/broker/src/auth.ts`) with the same order and rules.

## It never dials out

Three layers inside this process, and one outside it.

1. **No code that dials.** Nothing under `verdict-host/` makes a client
   connection of any kind. `test/unit/verdict-host-no-egress.test.mjs` scans
   every file the process loads and fails on a client API, a `connect` call, a
   module that can reach the network, or a way to start another program.
2. **A guard.** `egress-guard.js` is installed first in `main.js`. It replaces
   the socket `connect`, UDP `send`, and every DNS lookup other than an IP
   literal (which Node does to listen on an address) with a refusal that
   throws `EgressRefusedError`. A refused attempt counts in
   `verdict_host_egress_refused_total`, where any value above zero is a defect,
   and in a process that did not catch it, ends the process.
3. **A run beside a canary.** The same test starts the real process, drives a
   full round through it, and fails on any connection to a canary listener, any
   refusal printed, or an early exit. Two deliberately wrong variants (one with
   the guard, one without) must be flagged by the same run.
4. **Outside this process.** The guard is not a sandbox: code in the process can
   undo it. The load-bearing control is the unit that runs the process denying
   it every network address but its own listener. That unit is not part of this
   change.

## Metrics

Written every 15 seconds to the textfile. The names are a contract for alert
rules; change them together.

| Series | Meaning |
| --- | --- |
| `verdict_host_oldest_unverdicted_age_seconds` | Age of the oldest hash without a verdict, handed over or not. Zero when none. Grows while nothing drains. |
| `verdict_host_queued_hashes`, `verdict_host_leased_hashes` | Waiting, and handed over. |
| `verdict_host_last_poll_timestamp_seconds` | Last authenticated poll; 0 since start if none. |
| `verdict_host_polls_total{result}` | `batch`, `empty`, `busy`. |
| `verdict_host_posts_total{result}` | `accepted`, `gone`, `unreadable`. |
| `verdict_host_asks_total{result}` | `verdict`, `queued`, `full`, `error`, `bad`. |
| `verdict_host_refused_total{reason}` | Inbound requests refused as not from the service. |
| `verdict_host_egress_refused_total` | Dial attempts refused by the guard. |

## Not in this change

The unit that runs the process and denies it the network; the descriptor entry
that gives each host its inbound address and key; the route that lets the safety
service reach a host from outside; a shared home for the signed-request check
and the verdicts reader. The entry file passes the socket transport to the
decorator at `verdictSocketPath` (`../src/verdict-source.md`).

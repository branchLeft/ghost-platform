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
| `COLLECTOR_OUTCOMES_RETURN_PATH` | no (off) | Opt-in outcome path. The envelope sender (return path) mx1 sends delivery status notifications to. Must be set together with `COLLECTOR_OUTCOMES_DSN_DIR`, or startup fails. With both unset, submissions and the drain loop are exactly as before. |
| `COLLECTOR_OUTCOMES_DSN_DIR` | no (off) | Directory the notifications for that return path arrive in, one `.eml` file each. Handled files move to `processed/` beside them, never deleted. |
| `COLLECTOR_OUTCOMES_POLL_MS` | no (default `30000`) | How often the directory is read. |

## Design

See the delivering PR's body for the drain-list-derivation and
estate-wide-throttle design decisions; this file states the mechanics env
vars need plus the source notes below, which is load-bearing enough to
live where it can't drift from the code that implements it.

`docker-proof/deadmans-switch/run-deadmans-switch-proof.sh` proves
`src/heartbeat.ts` against a real local Healthchecks instance rather than
a mock — see its own header comment and the delivering PR's body for a
recorded run.

## Outcomes carried back to the spool

"Delivered" has to mean the receiving MTA delivered it, not that mx1 accepted
the submission. With `COLLECTOR_OUTCOMES_RETURN_PATH` and
`COLLECTOR_OUTCOMES_DSN_DIR` set (off otherwise), the collector:

1. submits each message with a Message-ID that encodes the message id, its claim
   generation and its spool (`outcomeId.ts`, under the reserved `.invalid` TLD),
   an envelope sender of the return path, and a DSN request for success, failure
   and delay. Nothing about an in-flight message is held in memory, so a restart
   loses nothing;
2. acks as before. At this point the spool holds the message as `sent`
   (accepted), and no `delivered` event exists;
3. reads delivery status notifications from the directory (`dsnMailbox.ts`),
   parses the RFC 3464 report (`dsn.ts`) and reports the outcome to the spool the
   Message-ID names, over the same authenticated connection
   (`POST /drain/outcomes`, `outcomeRunner.ts`).

Only `Action: delivered` with a `2.x.x` status is delivered. `relayed` and
`expanded` hand the message to a system that will not report back, so they yield
no outcome. `failed` is permanent unless the status is `4.x.x`; `delayed` is
temporary. A notification is retired only after the spool answered for it, so an
unreachable spool, or one that has not opted in (404), keeps it for the next
pass. A notification for a spool the descriptor no longer names is left, never
sent to a guessed address. How notifications get into the directory, and whether
mx1 honours the DSN request at all, is the mx1-side half and is unproven; see
the delivering PR's runbook.

## Source notes

One section per symbol whose source comment was trimmed to a pointer here.

### collectorLoop createCollectorRuntime

Runs one drain-and-deliver loop per host the descriptor currently names,
and reconciles that set of loops every `descriptorRefreshMs` against
whatever the descriptor now says — adding a loop for a host that just
appeared, and retiring one for a host that dropped out or expired. A host
absent from the descriptor at construction time, or removed from it later,
never gets a loop at all: this is the mechanism behind LLD-6 §09's
load-bearing property, that a host not in the drain list is a host whose
mail is never collected, however reachable it stays on the network.

`deps.throttle` and `deps.health` are each shared across every target loop
this function starts — one instance, passed once, never constructed
per-target. That sharing is what makes the throttle an estate-wide ceiling
rather than N independent per-host ones, and what lets `health` reflect
the collector's submission health as a whole rather than one host's
routine outage.

### dedupe SubmittedTracker

Named `submitted`, not `delivered` — LLD-6 M5 (load-bearing): delivered
must come from mx1's delivery outcome, not the submission hop, otherwise a
tenant's delivery rate is a submission rate and silent bounces never
surface. What this tracker actually knows, the moment it records
something, is that mx1's SMTP front accepted the DATA command for that
message — nothing about whether mx1 went on to relay it, or whether it
bounced afterwards. The shim's own `ackDrain` doc comment
(`services/mailgun-shim/src/store.ts`) draws the identical line for the
same reason: an ack means the drainer took responsibility for the
message, not that anyone received it. Relaying mx1's real delivery
outcome back through this pipeline is a separately planned mechanism,
deliberately out of this service's own scope: this tracker records
submission to mx1, never delivery.

### dedupe createSubmittedTracker

What turns the shim's documented at-least-once drain (`routes/drain.ts`: a
lease that lapses before an ack is re-offered to this drainer again or to
another one) into exactly-once submission at mx1. A message id is stable
across re-offers (the shim's own contract), so remembering which ids this
process has already handed to mx1 is enough: a re-offer caused by a lost
ack is recognised here and skipped, not resubmitted — only re-acked, to
finally clear it from the shim's queue.

Bounded by a TTL rather than kept forever, so a long-running process does
not accumulate one entry per message ever sent. The TTL only needs to
outlast the window in which a re-offer of the same id can plausibly still
arrive (bounded by the shim's lease length plus however long an ack can
stay lost); the default in `config.ts` is an hour, comfortably past that.

### descriptorTargets DescriptorTargetStore

The drain list this collector's whole design turns on (LLD-6 §09,
load-bearing: a host that is not in it is a host whose mail is never
collected). Built by reading a directory of tenant/demo descriptor JSON
files — the same descriptor every reconciler renders from — never from a
separately maintained host list. A descriptor that expired, that fails
the shape check, or that simply is not on disk here contributes no
target, however reachable its host still is on the network.

Mirrors odask's `DescriptorStore`: `targets` keeps answering from the
last good read while a refresh is in flight or fails, but only up to
`maxStalenessMs` — past that, `targets` returns empty rather than
keep-draining a snapshot this service can no longer vouch for.

### descriptorTargets duplicate slug handling

Refuses the whole batch rather than pick a winner: which of two
descriptors naming the same slug is "right" is not this store's call, and
adopting either one silently would look identical to the healthy case
from every caller's point of view. Thrown, not just logged — refuse at
load: `server.ts`'s uncaught startup `await store.refresh()` fails closed
on this rather than booting with an ambiguous host list, while
`collectorLoop.ts`'s periodic refresh already `.catch()`es a rejected
`refresh()` and keeps its last good target list, the same fallback a
directory-read failure gets — a pre-existing, unambiguous set keeps
draining while this is fixed upstream.

### health HealthState

Whether the estate's dead-man's switch should keep hearing from this
process. Deliberately minimal — a single consecutive-submission-failure
counter, not a per-class oldest-undrained-age metric, which needs a
design decision on what a "class" is here that this story does not make;
filed separately rather than built speculatively.

What this does cover: a collector that cannot submit anything to mx1 —
wrong credential, mx1 down, every connection refused — must not keep
paging "healthy" forever just because its own liveness loop is still
running. `recordFailure` is called only on a delivery (SMTP submission)
failure, never on a drain fetch failure against one host among several —
one unreachable spool among many healthy ones is not "the collector is
stuck", and conflating the two would suppress the heartbeat over a single
host's routine outage.

### heartbeat onCycleComplete

Call once per target, once per completed poll cycle for that target —
drained-and-delivered or drained-nothing, it does not matter which, an
empty poll is a success. Never call it for a cycle that errored (a drain
failure against that host) or that never finished (a wedged loop):
omitting the call is exactly what silences the switch for that target.
Never called on this module's own timer, deliberately: a timer
independent of the callers' loops keeps firing exactly while one of them
is wedged (blocked on an unresolved fetch, a held socket, anything that
never returns), and a ping driven by anything other than every loop's own
forward progress would report that a stuck worker is alive. This is the
mechanism behind LLD-8 §03b's dead-man's-switch requirement and its
load-bearing mark: silence and failure must look identical, never
silence looking like health.

### heartbeat createDeadMansSwitch

The estate's shared dead-man's-switch client — pings Healthchecks.io (or
the local instance standing in for it in proof) once per period in which
every currently-expected target has reported a completed poll cycle,
never on an interval of its own. An idle worker that keeps completing
empty cycles keeps pinging, so the switch stays up (LLD-8 §10b's control
case, load-bearing: an idle worker with nothing to drain must not page);
any one target whose loop stops progressing — crashed, wedged, or
permanently failing its drain — simply never reports again, which is
enough on its own to withhold every subsequent ping: many sites having
zero mail in a cycle is not a failure, but one site never completing a
cycle is, and it must silence the switch exactly as a fully wedged worker
would. The switch itself (via the Healthchecks period/grace configured
against it, which this module treats as an external, incidental tuning
knob) turns Late then Down on its own schedule once pings stop, no timer
or watchdog needed here.

Bookkeeping: a target id reported via `onCycleComplete()` is held in a
per-period set until every id `getExpectedTargetIds()` currently names is
present, at which point the switch pings (subject to `shouldPing()`) and
the set is cleared for the next period. A target that drops out of the
expected set (removed from the descriptor) is simply no longer required;
one that is added starts the next period absent, same as any other.

The ping itself is fire-and-forget: `onCycleComplete()` never returns a
promise the caller could accidentally await, because awaiting a slow or
hung ping request inside the collector's own poll loop would make the
switch's own liveness check the next thing that wedges the worker it is
meant to protect.

### throttle token bucket

The estate-wide token bucket, in messages/hour. This is the shim's own
per-spool bucket (`services/mailgun-shim/src/throttle.ts`), relocated
rather than copied by import: that module's own comment documents why it
has to move once every host gets its own spool (LLD-6's end state) — N
spools each independently allowed up to `messagesPerHour` is N times the
intended rate against the one address that carries mx1's sending
reputation. This collector is the single egress point every spool's mail
converges on, so it is the one place left that can still bound the real
rate; the shim's bucket stays where it is, gating how much any one spool
can hand over in a single drain, never the estate total.

Starts with exactly one grace token, not a full bucket and not zero, for
the same reason the shim's own bucket does: zero would make the very
first message this process ever forwards wait out a full
1/messagesPerHour hour before anything has actually burst, breaking this
story's own "within a second of enqueue" cold-start criterion for no
protective reason; a full bucket would let a freshly restarted collector
burst up to the hourly cap immediately, defeating the point of a ceiling
that exists to protect mx1's IP reputation across restarts, not just
within one process lifetime.

### fakeShimServer FakeShimServer

A real local HTTP server implementing the same wire contract as
`services/mailgun-shim/src/routes/drain.ts` (`GET /drain`,
`POST /drain/ack`, the `WireMessage` shape, drainCount-gated acks) —
exercised over a real socket by the tests in this directory, never
imported from the shim itself (each service here is an independent
package; see `drainClient.ts`'s own comment on why this collector is
proven against the contract by running something real, not by sharing
code with the shim).

`enqueue()` and `simulateLostAck()` give tests direct control over the
two cases this story's Done criteria name explicitly: a message that
should never be offered at all (never enqueued here), and a message whose
ack the collector never gets a chance to send (lease lapses via
`simulateLostAck()`, which re-offers it under a new drainCount exactly as
the real shim's `claimForDrain`/lease-lapse path does).

### collectorLoop test proactive throttle reload

`throttle.ts`'s own `waitForToken()` already calls `reload()` on every
attempt while a message is actively waiting for a token — that path was
never the gap. The gap is a collector with no message in flight at all:
nothing calls `waitForToken()`, so nothing reloads, unless the main loop
itself reloads on every iteration regardless of drain content
(`collectorLoop.ts`'s own call, right after re-reading the live target).
This test isolates exactly that: the collector sits idle on empty drains
for a while, the file is edited, and only then does a message get
enqueued — proving the new rate was already loaded before there was
anything to throttle, not fetched reactively once needed.

### wiring test end-to-end wiring

Everything else in this directory either proves the real
`DescriptorTargetStore` reads only the descriptor
(`descriptorTargets.test.ts`) or proves the loop only ever drains what a
`TargetStore` names (`collectorLoop.test.ts`, against a plain test
double). This file is the one place both halves run together through the
real construction path `server.ts` uses — a real `DescriptorTargetStore`
reading real descriptor files on disk, feeding the real collector loop —
so a break in the wiring between them (not just in either module's own
logic) has somewhere to show up.

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
| `COLLECTOR_DEMO_MAIL_DOMAIN` | for a demo host | The platform's shared demo mail domain: the one domain a demo host's header From may carry (a demo descriptor holds a local part only). Unset, the mail of every demo host is held, unsent and unacked, and the collector logs `demo_mail_domain_not_set` at start-up. See the header From scope section. |
| `COLLECTOR_SHIM_PORT` | no (default `8080`) | The HTTP port every host's mailgun-shim listens on for its drain surface — a deployment convention, combined with the descriptor's own `appHostIp`. |
| `COLLECTOR_DRAIN_TOKEN` | yes | The drain endpoint's shared bearer credential. One value across every host today — see the PR body's Design section for why, and what changes once per-host tokens exist. |
| `COLLECTOR_DRAIN_TIMEOUT_MS` | no (default `40000`) | Client-side timeout for one `GET /drain` call. Must exceed the target shim's own `SHIM_DRAIN_HOLD_MS`. |
| `COLLECTOR_DRAIN_RETRY_BACKOFF_MS` | no (default `2000`) | Backoff after a failed drain/ack call to one host before retrying it. |
| `COLLECTOR_EMPTY_POLL_BACKOFF_MS` | no (default `250`) | Backoff after a `GET /drain` that answered with zero messages, before polling that host again. |
| `COLLECTOR_MESSAGES_PER_HOUR` | no (default `50`) | The estate-wide send-rate ceiling, moved here from the shim's per-spool bucket. |
| `COLLECTOR_THROTTLE_CONFIG_PATH` | no | Optional live-reloadable override file, `{"messagesPerHour": N}`. This is the bulk lane's ceiling. |
| `COLLECTOR_LOGIN_MESSAGES_PER_HOUR` | no (default `3600`) | The login (transactional) lane's own ceiling. Login mail never spends bulk tokens. |
| `COLLECTOR_BULK_RAMP_PATH` | no (off) | Optional live-reloadable bulk ramp file. Unset, bulk runs at the bulk ceiling alone. See the bulk lanes section. |
| `COLLECTOR_DEDUPE_TTL_MS` | no (default `3600000`) | How long a submitted message id is remembered, to recognise a re-offer caused by a lost ack. |
| `COLLECTOR_DEDUPE_STATE_PATH` | no (off) | File, on a volume that outlives the container and is writable by the `node` user, the submitted ids are kept in. Unset, the ids live in memory only: a restart forgets them and the collector logs `dedupe_not_persistent` at start-up. |
| `COLLECTOR_BULK_DEFERRAL_STATE_PATH` | no (beside `COLLECTOR_DEDUPE_STATE_PATH`, as `bulk-deferral.json`) | File the bulk deferral hold is kept in, so a restart during the hold does not forget it. With neither this nor the dedupe path set, the hold is memory-only. A missing file is no hold; a file that cannot be trusted starts a fresh hold. |
| `COLLECTOR_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | yes / no (`587`) / yes / yes | mx1's authenticated SMTP submission endpoint. |
| `COLLECTOR_SMTP_SECURE` | no (default `false`) | `true` for implicit TLS. |
| `COLLECTOR_SWEEGO_SMTP_HOST` | no (off) | The Sweego relay host (`SWEEGO_RELAY_HOST`). Setting it turns the Sweego client on; the settings below are then required where marked, and set without it they fail start-up. |
| `COLLECTOR_SWEEGO_SMTP_PORT` / `_SECURE` | no (`587` / `false`) | The relay port (`SWEEGO_RELAY_PORT`) and whether it is implicit TLS. With `_SECURE` false the client requires STARTTLS before it sends the credential. |
| `COLLECTOR_SWEEGO_SMTP_USER` | with the host | The relay login name (`SWEEGO_RELAY_USER`). |
| `COLLECTOR_SWEEGO_SMTP_PASS_FILE` | with the host | Path of the root-readable file on ops1 that holds the relay credential, and nothing else but an optional trailing newline. The value is never an environment variable: `COLLECTOR_SWEEGO_SMTP_PASS` is refused at start-up. |
| `COLLECTOR_SWEEGO_MESSAGES_PER_HOUR` | with the host | Sweego's own send-rate ceiling (`SWEEGO_MESSAGES_PER_HOUR`), separate from `COLLECTOR_MESSAGES_PER_HOUR`. No default: the plan sets it. |
| `COLLECTOR_SWEEGO_THROTTLE_CONFIG_PATH` | no | Optional live-reloadable override, `{"messagesPerHour": N}`, for the Sweego ceiling only. |
| `COLLECTOR_SWEEGO_SMTP_TIMEOUT_MS` | no (default `20000`) | Bounds connecting, the greeting and every wait on the relay, so a down relay fails fast. |
| `COLLECTOR_SWEEGO_ACCOUNT_CAP` | to use Sweego | Messages per UTC calendar month across every tenant together, held inside the Sweego plan (`SWEEGO_ACCOUNT_CAP`). A positive integer; no default. Unset, Sweego is treated as not configured: the collector logs `sweego_not_configured` and every message goes through mx1. |
| `COLLECTOR_SWEEGO_USAGE_STATE_PATH` | to use Sweego | File, on a volume that outlives the container and is writable by the `node` user, the monthly counters are kept in (`SWEEGO_USAGE_STATE_PATH`). Unset, Sweego is treated as not configured, the same as an unset cap. |
| `COLLECTOR_PIN_STATE_DIR` | no (off) | Directory, on a volume that outlives the container and is writable by the `node` user, the per-message target pins are kept in. Unset, a restart forgets them and the collector logs `pins_not_persistent` at start-up, so the rollout must set it before Sweego is enabled. |
| `COLLECTOR_PIN_TTL_MS` | no (default `3024000000`, 35 days) | How long a pin is remembered, counted from the attempt that made it. It must outlast the longest hold at the Sweego account cap (31 days, the longest UTC month, `MAX_CAP_HOLD_MS` in `sweegoUsage.ts`), so the default adds four days. A value below 31 days (`2678400000`) is refused at start-up. The shim re-offers an unacked row every `SHIM_DRAIN_LEASE_SECONDS` (30 s; `services/mailgun-shim/src/config.ts`) with no attempt cap and no maximum age, and the drain contract sets none, so this TTL is the only time bound on a held pinned message. |
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
the shared `deadmans-switch/src/heartbeat.ts` against a real local Healthchecks instance rather than
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
no outcome. `failed` is permanent only with an explicit `5.x.x` status, so a malformed
notice can never suppress an address; `failed` with `4.x.x` and `delayed` are
temporary; any other status yields no outcome. A notice the spool calls `unknown` (usually because it arrived before the ack) is kept and retried, and only retired as unplaceable after an hour. A notification is otherwise retired only after the spool answered for it, so an
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

With `COLLECTOR_DEDUPE_STATE_PATH` set, the ids are also written to that file
(temp file, fsync, rename, directory fsync), so the same skip holds across a
restart: the file is read back at start-up and a re-offered id is only
re-acked. An id is written after mx1 accepts the message, never before —
writing first would turn a crash before the SMTP accept into a message that is
skipped and acked without ever being sent, which loses mail. The window that
remains is a crash after mx1 accepts and before the write lands, which can
still produce one duplicate. A state file that cannot be read or written is
logged as `dedupe_state_error` and the in-memory tracker carries on; the
collector does not stop draining over it.

Bounded by a TTL rather than kept forever, so a long-running process does
not accumulate one entry per message ever sent. The TTL only needs to
outlast the window in which a re-offer of the same id can plausibly still
arrive (bounded by the shim's lease length plus however long an ack can
stay lost); the default in `config.ts` is an hour, comfortably past that.
Within that TTL an id is submitted at most once; once its entry expires, a
later re-offer of the same id would be submitted again.

The loop marks each submitted id as awaiting its ack, and such an id is not
swept at the TTL: it stays until the shim has taken it (`markAcked`, after a
successful ack call, which then starts the plain TTL), or for 14 days at the
most. A batch at a low ramp rate takes longer than the TTL (25 messages at 20
per hour is over an hour), and an ack is sent only when the batch ends, so an
id swept at the TTL would be sent again after a failed ack or a restart. The
set of ids awaiting an ack is written to the state file too, so it survives a
restart; a file written before this existed loads with every id treated as
acked. This was chosen over raising the TTL because the longest batch depends
on the shim's batch limit and the lowest ramp rate, neither of which this
service owns.

`sweep(keep)` takes an optional rule naming ids to leave alone however old they
are. The loop passes it for the two Sweego pin trackers, naming each message its
latest offer left held at the account cap, so a pin is never swept while its
message is waiting on the cap (see the pin TTL in the Sweego submission section).
The state-file format is unchanged.

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

### descriptorTargets mail route

Each `DrainTarget` carries `route`, read from the descriptor's optional
`mail.route.primary` (`mx1` or `sweego`); a descriptor that names none means
`mx1`. A `sweego` route also carries `sweegoAllowance`, the tenant's messages
per UTC month through Sweego, and the target carries it too. A route that is
present but not exactly `{ primary: "mx1" }` or `{ primary: "sweego",
sweegoAllowance: <positive integer> }` makes the descriptor malformed, so that
host is not drained, and a demo that names `sweego` is malformed the same way. The shape check is this service's
own, as for the rest of the descriptor, so it mirrors render-core's rule and
does not import it.

A demo target also carries `demo: true`, which the resolver reads (below). With
no Sweego delivery client the drain output is byte-identical whatever `route`
is (`test/unit/routeCarried.test.ts`).

### header From scope

A documented control of the collector: **a message is submitted only if its
header From names exactly one mailbox, in its host's sending domain.** Stalwart
checks the envelope sender for the scoped credential on mx1; the collector
checks the header, before any target is chosen, so the one check covers mx1,
Sweego and the fall-back from one to the other (`headerFromScope.ts`, called
first in `submit`). `server.ts` always switches it on (`enforceHeaderFrom`).

- **Scope.** A tenant's sending domain is `mail.identity.domain` in its
  descriptor. A demo descriptor carries no domain, so a demo's is
  `COLLECTOR_DEMO_MAIL_DOMAIN` (the platform's shared demo mail domain). The
  target carries it as `sendingDomain`; there is no second source.
- **Match.** Exact equality of the domain, after lower-casing, dropping trailing
  dots and converting an internationalised domain to its punycode form (the
  form the SMTP clients send). Never a subdomain or a suffix. The address is read
  by the parser the SMTP clients use to build the header, so the address checked
  is the address sent.
- **Refused as `from-unreadable`** (fail closed): no From, a non-string, a blank
  or over-long value, a control character (a line break would let a second line
  be read as the header), no mailbox, more than one mailbox, group syntax, an
  `@` left in the local part, a space in the local part, an encoded word in the
  address, a domain that is not a hostname, and a custom `From`, `Sender`,
  `Return-Path`, `Resent-From` or `Resent-Sender` header (the spool never
  forwards `Sender`, so one here was not made by the spool). A display name is
  not read: a name that looks like an in-scope address does not make a message
  in scope.
- **Refused as `from-out-of-scope`:** one readable mailbox in any other domain,
  including another tenant's.
- **A refusal** is permanent: the message is marked in the dedupe tracker, acked
  and never sent or retried, the same ending as a dropped recipient. It is not
  reported to the spool as a failed recipient, because that report suppresses the
  recipient's address and the recipient is not at fault. The spool therefore shows
  the message as accepted. It is counted in the failure counter under its reason.
  The log line (`header_from_refused`) carries the reason and the message id only:
  no host, recipient, subject, domain or address.
- **No scope** (`from-scope-unknown`): a host whose descriptor names no sending
  domain, or a demo with no demo mail domain configured (logged once at start-up
  as `demo_mail_domain_not_set`), has its mail held: left unacked, so the spool
  offers it again once the descriptor or the setting is fixed. Nothing is lost
  and nothing is sent.
- **What it does not cover.** `Reply-To` is not checked (a reply address outside
  the domain is ordinary). The Sieve check on mx1 and the DMARC policy of the main
  domain are separate, owner-chosen mitigations; this one is in code and does not
  replace them.

### sendingTarget resolveSendingTarget

`resolveSendingTarget(route, context)` is pure and answers `mx1`, `sweego` or
`hold` (leave the message unacked; the shim re-offers it). The loop in
`collectorLoop.ts` asks it before each submission and, after a Sweego failure,
asks again with the failure. The hard rules, in the order they apply:

1. After a failure, the only edge is Sweego to mx1 (`FALLBACK_EDGES`), taken by
   transactional mail (wire `emailId` null) after a definite non-acceptance
   (`not-accepted`: connection refused, DNS, authentication, a 4xx at MAIL or
   RCPT) and by nothing else. A recipient 5xx and an ambiguous failure (a timeout
   after DATA, or any error that names no kind) hold the message; bulk always
   holds. An unclassified error is ambiguous: a client says `not-accepted` only
   by throwing `TargetSubmissionError`. The loop does not ask the resolver about a
   recipient 5xx: it drops the message (see Sweego submission below).
2. A `mx1` route, a demo and any message that already reached mx1 go to mx1.
   Nothing goes from mx1 to Sweego: `FALLBACK_EDGES` has no edge out of mx1, the
   route has no field to say otherwise, `assertNoSweegoAfterMx1` is the last
   guard, and the loop records every mx1 attempt in `mx1Pins` before it is made.
3. No Sweego delivery client, an allowance reached or the account cap reached
   sends the message to mx1 through the estate throttle. `sweegoQuota` unset is
   read as reached, so nothing goes to Sweego until a counter is supplied. The
   loop supplies the allowance as reached only for bulk: login mail never
   consults the tenant's latch, but the account cap holds for every class.
4. Otherwise Sweego, which bypasses the estate throttle and never touches the
   mx1 health counter that gates the heartbeat.

A message held for Sweego does not stop the rest of its batch (an mx1 failure
still does). `server.ts` builds the Sweego client and the counter only when
`COLLECTOR_SWEEGO_SMTP_HOST`, `COLLECTOR_SWEEGO_ACCOUNT_CAP` and
`COLLECTOR_SWEEGO_USAGE_STATE_PATH` are all set; with any one missing every
route is served by mx1. The pins are kept under `COLLECTOR_PIN_STATE_DIR` when it is set;
their TTL is a placeholder that must outlast the shim's longest retry horizon.

### sweegoDeliveryClient createSweegoDeliveryClient

Authenticated SMTP submission to the Sweego relay, tested against a local fake
relay (`test/helpers/fakeSweegoRelay.ts`), never a real host. The credential is
read from `COLLECTOR_SWEEGO_SMTP_PASS_FILE` for each message and passed to one
transporter that lives for that message alone, so it is held nowhere else: not in
config, not in the client, not in a pooled connection, not in the descriptor, the
spool or a tenant host. The client requires STARTTLS (or implicit TLS) before it
sends the credential; only a test against a fake relay with no TLS turns that off.

Every failure is thrown as a `SweegoSubmissionError` whose message is built from
a reason and the SMTP reply number only. The relay's own text, which can echo an
address, and the underlying error are dropped, so no log line, exception, counter
or metric can carry the credential, a recipient or a subject. A test greps all of
them across every failure the fake relay can produce.

The Sweego throttle (`sweegoThrottle`) is a second `createThrottle`, with its own
rate and its own reload file. Sweego mail draws only on it, mx1 mail only on the
estate throttle. A Sweego client supplied without a throttle is read as not
configured.

### sweegoFailure classifySweegoError

Maps a nodemailer error onto the design's outcomes. Only a definite
non-acceptance is `not-accepted`, which is what lets login mail fall back to mx1;
anything that may have reached the relay's queue, and anything unplaced, is
`ambiguous` and never falls back, so it cannot duplicate a message.

| Reason | Kind | Cause |
|---|---|---|
| `unreachable` | `not-accepted` | Connection refused, DNS failure, TLS or greeting failure, connect timeout |
| `auth` | `not-accepted` | The relay refused the login |
| `credential` | `not-accepted` | The credential file is unreadable or empty |
| `deferred` | `not-accepted` | A 4xx at MAIL, RCPT or the DATA command |
| `refused` | `not-accepted` | A 5xx at MAIL or the DATA command: refused before any content, nothing taken |
| `recipient-rejected` | `recipient-rejected` | A 5xx at RCPT, or an envelope the client could not form |
| `timeout` | `ambiguous` | A timeout once the session was past setup |
| `ambiguous` | `ambiguous` | A failure at or after DATA, a reset mid-session, anything unplaced |

`unclassified` is the count label for a failure that no Sweego client classified.
The loop records each failure in `sweegoFailures` (`submissionFailures.ts`), a
counter keyed by reason alone, for the signals that read it.

### collectorLoop Sweego submission

- **The pin.** The first attempt at Sweego writes the message id to
  `sweegoPins` before the attempt is made. A retry then stays on Sweego whatever
  the route or the quota has since become, because the earlier attempt may have
  been taken. If the process holds no Sweego client at that point the message is
  held (`sweego_pinned_unavailable`), never sent to mx1. The login fallback is the
  one exception: its mx1 attempt is pinned in `mx1Pins`, which takes over.
- **The accept.** A Sweego accept marks the dedupe tracker, so a lost ack is only
  re-acked on the next offer and never re-sent.
- **The terminal outcome.** Only a bad address is dropped: a 5xx at RCPT, or an
  envelope the client cannot build. It is marked in the dedupe tracker, acked,
  counted under `recipient-rejected`, and never retried or sent to mx1. Every
  other refusal, a 4xx at any step and a 5xx at MAIL or the DATA command or after
  DATA, is held and retried (login mail falls back to mx1 once, only when nothing
  was taken) under its own counted reason. Once the drop is acked, the spool is
  told it failed for good (see [a dropped recipient reported back to the
  spool](#a-dropped-recipient-reported-back-to-the-spool)).
- **An attempt that may have been taken.** When an attempt ends ambiguous
  (a timeout, a failure after DATA, anything unplaced) the id is recorded in
  `sweegoAmbiguous`. A later definite failure for the same message is then read as
  ambiguous too, so login mail does not fall back to mx1 and arrive twice. A bad
  address is still dropped. The attempt is counted against the tenant allowance and
  the account cap (see `sweegoUsage`), once per message however it ends later.
- **A pinned message and the account cap.** A pinned retry goes to Sweego whatever
  the tenant's allowance says, and the account cap holds for it: at the cap it is
  left unacked (`sweego_pinned_held_at_cap`), never sent above the cap and never to
  mx1 (its first attempt may have been taken). A pinned retry of a message that
  already holds a place (an earlier attempt ended ambiguous and was counted, or its
  reserved place was recounted after a crash, see `sweegoUsage`) is the exception:
  its place is already inside the count, so the cap does not hold it and the retry
  reserves nothing more. Any other pinned retry is counted in the same reservation
  as a first attempt. The overshoot past the cap is therefore bounded by the
  messages in flight together, not by the pinned backlog, and a crash does not add
  to it: every reservation is on disk before its send.
- **How long a pinned retry can be held (decision recorded).** A hold at the cap
  ends when the cap is lifted: at 00:00:00 UTC on the first of the next month, or
  sooner if the owner raises the cap (a bigger plan). So the longest a message can
  be held for the cap is the rest of the calendar month, at most 31 days, and the
  held message is sent in the first poll after the boundary. The cap is a spend
  limit, so it wins over delivery: this hold is accepted, not shortened, because
  the only ways to shorten it are to send above the cap or to send through mx1
  something Sweego may already have delivered. The shim re-offers an unacked row
  every `SHIM_DRAIN_LEASE_SECONDS` (30 s by default) with no attempt cap and no
  maximum age, and the drain contract sets none, so nothing cuts a hold short and
  the pin TTL is the only time bound on one. That is why the default
  `COLLECTOR_PIN_TTL_MS` is 35 days (31 plus four) and start-up refuses less than
  31 days, and why the pin sweep never drops the pin of a message held at the
  cap. A test pins the bound: held at 23:59:59.999 UTC on the last day, sent at
  00:00:00.000 on the first; another holds a pinned retry at the cap on day 8
  and shows it stays pinned, uncounted a second time and unsent to mx1.
- **A pin file that cannot be trusted.** The three pin files are written
  atomically, but if one is corrupt or unreadable at start-up its ids are lost.
  The same holds for a file that has vanished (missing though a first save was
  made, see [state markers](#state-markers)).
  The tracker records that (`stateLost`, kept in the file so a restart still knows)
  for one pin TTL. In that time a message on a Sweego route that the shim is
  offering again (`drainCount` above 1) and that no pin remembers is held
  (`pin_state_lost_held`), never sent to mx1 or to a second Sweego attempt: a held
  message waits, a released one can arrive twice. First offers are unaffected.
- **Rollout.** The hand-delivered rollout must set `COLLECTOR_DEDUPE_STATE_PATH`,
  `COLLECTOR_PIN_STATE_DIR` and `COLLECTOR_SWEEGO_USAGE_STATE_PATH` (all three on a
  volume that outlives the container), or that state is memory-only. Without
  `COLLECTOR_PIN_STATE_DIR` a restart forgets every pin and ambiguity record, and
  with them the protection above (the collector logs `pins_not_persistent` at
  start-up); without `COLLECTOR_SWEEGO_USAGE_STATE_PATH` Sweego is not used at all.
  Set all three before Sweego is enabled. `COLLECTOR_PIN_TTL_MS` defaults to 35
  days and start-up refuses less than 31 (see the variable's row). A pin
  sweep, every `dedupeSweepMs`, drops a pin older than the TTL, except one for a
  message the latest offer left held at the account cap
  (`sweego_pinned_held_at_cap`): that pin is kept for as long as the message is
  offered and held. The same bound is the length of the `stateLost` window, so
  after a lost pin file a re-offered Sweego message nothing remembers is held for
  up to 35 days instead of 7. `COLLECTOR_DEDUPE_TTL_MS` is not tied to the pin
  TTL: a dedupe entry only has to outlast a lost ack (and an entry awaiting its ack
  is kept up to 14 days regardless), and a pinned message held at the cap is not
  in dedupe at all.

### sweegoUsage createSweegoUsage

The counter the resolver asks (`SweegoQuota`), and the one place the Sweego
allowance and the account cap are enforced. Example settings, all
placeholders: `COLLECTOR_SWEEGO_ACCOUNT_CAP=SWEEGO_ACCOUNT_CAP`,
`COLLECTOR_SWEEGO_USAGE_STATE_PATH=SWEEGO_USAGE_STATE_PATH`, and in a tenant's
descriptor `mail.route: { primary: "sweego", sweegoAllowance: TENANT_ALLOWANCE }`.

- **What is counted.** Messages Sweego accepted, plus attempts that may have been
  taken, per tenant and in total, by UTC calendar month (`YYYY-MM`, from an
  injectable clock). The loop calls `begin(tenant, message)` before an attempt and
  `settle(true)` after the accept, after the dedupe mark and before the ack. An
  attempt that ends unplaced (a timeout, a failure after DATA) calls `ambiguous()`
  and is counted, because Sweego may have delivered it. Any other end (a definite
  refusal, a bad address) settles `false` and counts nothing. A message counts once
  a month: the file keeps a digest of each message counted at an ambiguous end
  (never the id), and a later accept for it is not counted again. A lost ack is
  re-offered but skipped by the dedupe tracker, so it cannot count twice. A crash
  between the accept and the write undercounts by one (the dedupe mark is made
  first, so the message is not sent twice for it).
- **In flight counts.** The quota questions include attempts begun and not yet
  settled. The loop asks again after the Sweego throttle wait and begins in the
  same tick, so tenants with a message in flight together cannot take the total
  past the cap, and a latch that arrived during a throttle wait is honoured.
- **A reservation is written before the send.** `begin` saves the state file, with
  the place in an `inflight` list, before it returns, and the loop pins the message
  and sends only after that. The save that settles the attempt (the count, or the
  release of a refused attempt) also removes the place from the list, in one write.
  A process that dies between the two leaves the place in the file, and the next
  start counts it as used (`inflight-recounted`, once for each), because the send
  may have been taken; the overshoot a crash can cause is therefore nil, where it
  was the number of sends in the air. A message counted this way holds its place:
  its retry is counted once, not twice. `begin` returns no slot when it cannot
  save (the state is unreadable, vanished or corrupt, or the write fails): the
  loop then logs `sweego_reservation_failed`, pins nothing, sends nothing and
  leaves the message unacked for the next offer, which the resolver reads against
  the latch as it stands.
- **A message that holds its place.** `holdsPlace(messageId)` is true for a message
  counted at an ambiguous end, or recounted after a crash, this month, and false
  while the counters cannot be trusted. For such a pinned message the loop does
  not ask the cap (its place is already inside the total, so the cap would hold a
  message that has already been paid for), and `begin` hands back a slot that
  reserves and counts nothing. The retry cannot take a second place, and it cannot
  be held at cap minus one by its own count.
- **The latch.** A tenant latches on the message that reaches its
  `sweegoAllowance` and stays latched until the month changes, even if the
  allowance is raised meanwhile (a descriptor can be stale; a raise takes effect
  next month). Its bulk then goes to mx1 through the estate (warm-up) throttle,
  late and not lost. Login mail never consults the latch and keeps going to
  Sweego; it is counted. The account cap is the plan's ceiling and holds for
  every class: reaching the total latches every tenant, login mail included.
  Unlike the tenant latch it is computed from the total, so raising the cap
  (the owner's act, with a bigger plan) lifts it at the next start.
- **Pin beats latch.** A message already pinned to Sweego keeps going there
  after its tenant latched, and is counted. The account cap is stricter: a pinned
  message is held at the cap (see the pinned bullet under the Sweego submission
  notes). So a tenant can end a month a few messages over its allowance, but the
  account stays inside the cap except for messages in flight together.
- **Rollover.** Every question reads the month from the clock, so a boundary
  crossed while idle is seen on the next question: counters and latches start
  at zero at 00:00:00 UTC on the first. A clock reading an earlier month than
  the stored counters changes nothing (`clock-behind-state`).
- **State.** One file, rewritten whole and atomically (temp file, fsync, rename)
  on every change; it holds the month, a degraded flag, per-tenant counts and,
  only while any exist, digests of the messages counted at an ambiguous end
  (`ambiguous`) and the places reserved and not yet settled (`inflight`, a list of
  `{ tenant, digest }`, the digest absent when the attempt carried no message id).
  `inflight` is new and optional: a file without it reads as no places in flight,
  and a build from before it ignores it. No message id, address or subject. A marker file beside it is written after the
  first successful save (see [state markers](#state-markers)).
- **Fail closed.** An unreadable or corrupt file (`state-unreadable`,
  `state-corrupt`) means usage is unknown: every tenant is latched and the cap
  is read as reached until the month changes, written down as `degraded` so a
  restart does not forget. A failed write (`state-write-failed`) latches
  everyone until a write succeeds again. A missing file with no marker is a first
  run, not a failure: counters start at zero. A missing file with the marker
  present has vanished (`state-vanished`): a fresh allowance must not follow a
  lost volume, so every send, bulk and login (the account cap holds for every
  class), goes to mx1. The latch is written into the file and survives restarts
  and month changes; only the owner clears it, by deleting the marker file
  (`<COLLECTOR_SWEEGO_USAGE_STATE_PATH>.initialised`) and restarting the collector,
  which keeps the counts it has and releases the latch. Unset cap or file path:
  Sweego is not used at all.
- **What it exposes.** `reasons()` counts events by label only (no tenant, no
  address, no subject) and is logged as `sweego_usage` with the reason alone.
  `tenantLatchState()` and `accountState()` are plain functions for the later
  signals to read per-tenant latch state; nothing here builds a label from a
  tenant.

### state markers

A state file that is missing is a first run only if it was never written. Each
persistent state file (the dedupe ids, the three pin files, the usage counters)
has a small marker beside it, `<state file>.initialised`, written once after the
file's first successful save, and after the file, so a crash between the two leaves
a file with no marker and never a marker with no file. At start-up:

| File | Marker | Meaning |
|---|---|---|
| missing | absent | First run. Clean, counters at zero. |
| missing | present | Vanished (an unmounted or wiped volume, a deleted file). Lost, as for a corrupt file: the pin trackers hold re-offered Sweego-route messages for one TTL, and the usage counter latches every send to mx1 until the owner deletes the marker. |
| present | absent | A file from before the marker existed, or the owner cleared the latch. The marker is written. |
| present | present | Normal. |

A marker that cannot be read (as against known to be absent) counts as present, so
doubt reads as a loss. A marker that cannot be written is a failed write: the usage
counter latches until it can be.

Limit: the marker lives on the same volume as the file. It catches a vanished file,
a deleted file or a state directory emptied in place; it does not catch a whole
volume replaced by a new empty one, because the marker goes with it. Catching that
needs a witness outside the volume, which this service does not have.

### a dropped recipient reported back to the spool

A recipient Sweego refuses for good is acked and dropped, so the spool would
otherwise show the message as accepted and never suppress the address. The
collector therefore tells the spool, over its existing outcome route
(`POST /drain/outcomes`, the same one the mx1 outcome path uses): a `failed`
outcome of severity `permanent`, which the spool records as a failed event and
adds the address to its bounce suppressions. No change to the spool is needed.

- It follows the ack, because the spool takes an outcome only for a message it has
  already marked sent. A drop whose ack is lost is reported with the generation of
  the re-offer that finally acks it.
- The text sent is fixed and names no address, subject or body.
- The spool serves the route only when opted in (`SHIM_DRAIN_OUTCOMES=true`). A
  spool that has not opted in answers 404: the failure is logged
  (`dropped_outcome_report_failed`) and tried again every five minutes, then given
  up on after a day (`dropped_outcome_abandoned`). The message itself is already
  acked and dropped either way.
- An `unknown` answer (the spool has not caught up with the ack) is kept and tried
  again. At most a thousand reports wait at once; the oldest is given up on first.

Known gaps: the waiting reports are held in memory, so a restart loses them (the
address is then not suppressed, as before this route was used); a spool that has not
opted in never learns of the drop.

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

### bulk and login lanes (lanes.ts)

Two lanes share the drain loop. Login (transactional) mail is a wire
message with no `emailId`; bulk mail carries one. The loop delivers each
batch's login messages before its bulk ones, and each lane spends its own
bucket: login the `COLLECTOR_LOGIN_MESSAGES_PER_HOUR` bucket, bulk the
estate throttle below.

The bulk rate is the lower of the configured ceiling and a ramp file
(`COLLECTOR_BULK_RAMP_PATH`), shaped as data:

```json
{ "startedAt": "2026-11-11T00:00:00.000Z",
  "steps": [ { "afterDays": 0, "messagesPerHour": 20 },
             { "afterDays": 7, "messagesPerHour": 100 } ] }
```

The rate is the last step whose `afterDays` has passed. Before `startedAt`,
the first step applies. A configured ramp that is missing or invalid runs
bulk at 1 per hour: late, not lost. The file is re-read when its mtime
changes; a rewrite that does not parse keeps the last good schedule.

A bulk submission that mx1 answers with `421 4.7.28` or `451 4.7.650`
halves the bulk rate for at least 10 minutes. A second such reply inside
that hold halves it again. The reduction clears once the hold passes. The
enhanced code counts only at the status code position of a reply line, so
the same digits in an address or a URL do not match. The deferral also
empties the bulk bucket, so the lower rate starts from nothing and a full
bucket is never released at once. The hold is written to
`COLLECTOR_BULK_DEFERRAL_STATE_PATH` (temp file, fsync, rename) and read back
at start-up, so a restart inside the hold keeps the halved rate. A hold end
later than one hold period from now is clamped to one period.

`startedAt` must be a complete ISO-8601 instant with a date, a time and a
zone, no later than five minutes ahead of the clock and no older than 366
days. Anything else makes the whole file invalid, so a typo such as `11` or
`2020` can never jump the ramp to its last step: the last good schedule is
kept, or with none loaded bulk runs at 1 per hour, which is never above the
first step.

Limits, stated so they are not mistaken for guarantees:

- A login message that arrives while a bulk batch is being worked waits for
  that batch to finish: the shim's drain has no class filter, so the
  collector cannot claim login rows past the bulk ones already leased to it.
  Lowering the wait needs a class-aware claim on the shim, a change outside
  this service.
- The collector sees only mx1's own replies. Receiver-side deferrals sit in
  mx1's queue and never reach this process. Per-destination caps belong in
  mx1's settings, not here.
- The ramp's evidence gate (rising only on clean bounce and complaint
  numbers) is not enforced by code: whoever edits the file applies it.

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

`messagesPerHour` from the constructor or the override file must be finite and
positive. An Infinity or NaN is not adopted: the previous rate stays, or the
default of 50 where there is none.

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

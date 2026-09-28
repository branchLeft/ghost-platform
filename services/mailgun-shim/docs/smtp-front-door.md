# SMTP front door — design notes

The narrative behind `src/smtpFrontDoor.ts` and its test suite
(`test/unit/smtpFrontDoor.test.ts`), moved out of inline comments per CMT-3.
Each source site keeps a short pointer back to its section here.

## Unauthenticated connection admission

### Pool guard counters

`createUnauthenticatedPoolGuard` keeps its own counters rather than filtering
smtp-server's own `connections` Set. smtp-server adds every accepted socket
to that Set the instant it accepts the TCP connection, then holds it for a
fixed ~100ms ("early talker" detection, `connectionReady()` in
`smtp-connection.js`) before this guard — inside the `onConnect` hook — ever
runs on it. A connection still in that dwell window has not been admitted by
anything yet, but a filter over the Set counts it anyway: a single source
churning connections fast enough keeps a rolling ~150-wide window of such
not-yet-checked connections permanently present, which pinned the global
count above its cap using connections that were themselves about to be
refused a moment later — starving a legitimate connection from a different
source thanks to the very source the cap exists to contain.

Counting only what this guard itself has let through removes the race: a
connection counts here from the instant it is admitted until this guard's own
`.release()` is called, never from mere socket acceptance.

### Queueing past the per-source cap

`createUnauthenticatedAdmissionQueue` queues a burst past the per-source cap
instead of refusing it outright. Several members signing in at once each open
their own connection from Ghost's one source address, and scrypt's ~21ms per
AUTH check runs serially, so more than the per-source cap's worth can be
genuinely unauthenticated at the same instant — a burst refused outright loses
real magic links to a `500`, not an attack. A cap sized to refuse nothing
would just move the same problem to a larger number reached by a
large-enough legitimate burst.

Queueing instead means a burst past the per-source cap waits — bounded in
both how many can wait and how long — for the ordinary trickle of releases (a
queued connection's own eventual AUTH, or another connection from the same
source closing) to admit it, rather than refusing it outright. The global cap
is never queued behind: it is the backstop for many distinct hostile sources
at once, a different threat this queue does nothing about and should not
soften.

### Per-source before global

Per-source is checked before global inside the guard itself: one source
address (e.g. a compromised, credential-less container) can never occupy more
than its own instantly-admitted share of the pool, however fast it churns
connections — replacing each one the instant it's refused or evicted defeats
a purely time-based deadline (reconnect faster than it) and doesn't need to
spread across addresses to defeat a purely global count-based cap. The global
cap is the backstop, sized well past what the per-source cap alone would ever
let one source reach, so it should never be the binding limit for a single
well-behaved source. A legitimate burst past the per-source cap does not get
refused outright: it waits, bounded, for the ordinary trickle of releases
from that same source — see the queueing section above.

## Connection bookkeeping

### RawSmtpConnection

`RawSmtpConnection` narrows `smtp-server`'s own connection objects, as held
in `SMTPServer.connections` (typed `Set<any>` upstream), to exactly what's
needed to tell an authenticated connection from an unauthenticated one, group
connections by source address, end one that has overrun its auth deadline,
and release a DATA phase's concurrency slot when the underlying socket closes
without the data stream itself ever emitting `end` or `error` (verified from
source: `_onClose`, `smtp-connection.js`, unpipes and nulls the data stream on
socket close without emitting on it). `session` here is the same object
instance `onAuth` mutates, so `.session.user` reflects live auth state, and
`_socket` is the real underlying `net.Socket` — private to smtp-server, but
real, and the only place a mid-transfer disconnect is ever observable from
outside it.

### Listener overview

`createSmtpFrontDoor` builds the listener Ghost's transactional sender
connects to (LLD-6 §01-§03): a durable local write, answered at once, with
nothing awaited past the SQLite transaction that makes the message durable.
It shares `enqueueBatch`/`claimDueRecipients` with the Mailgun-shaped HTTP
route (`routes/messages.ts`) — one queue, two front doors, exactly the
LOAD-BEARING shape LLD-6 §03 sets out.

`wake.notify()` is fire-and-forget by its own contract (`drainWake.ts`) —
nothing here awaits a network hop, which is the whole property this component
exists to hold.

### Slot release on close

The DATA concurrency slot must also be released if the underlying connection
closes before the stream reaches `'end'` or `'error'` — smtp-server detaches
the stream (unpipes it and sets it to null, `smtp-connection.js`'s
`_onClose`) without emitting on it when the socket closes mid-DATA, so
relying on the stream's own events alone leaks the slot forever on every
dropped connection, not only a deliberately malicious one: an ordinary
network blip or container restart mid-send does this. `_socket` is
smtp-server's real underlying `net.Socket`; its own `'close'` event fires in
every case a TCP connection ends, however it ends. `.once()` self-removes
once fired; the two other call sites remove it on the other two paths
instead, so a connection sending many messages in one session doesn't
accumulate one listener per message.

### Stream error unreachable

The data stream's own `'error'` handler is marked unreachable (`v8 ignore`)
having been checked exhaustively against smtp-server's own source rather than
assumed: nowhere in the library does anything call `.emit('error', ...)` or
`.destroy(...)` on the data stream (grepped the whole package: zero hits). A
socket error during the transaction (ECONNRESET/EPIPE with
`session.envelope.mailFrom` set) is emitted on the CONNECTION
(`this.emit('error', err)`, `smtp-connection.js`'s `_onError`), never
forwarded to the stream; the same error outside a transaction goes through
`_onClose` instead, which is the path the connection `close`-based release
(previous section) defends. Kept as a fail-closed guard against a future
smtp-server version starting to emit here, not because any input today can
reach it.

## AUTH

### Auth identity

In `onAuth`, the username IS the submitter's identity (a per-tenant/per-slot
domain, same shape as the Mailgun HTTP route's tenant key) — a submission is
never trusted because of where it came from or what address it claims to
send as. This credential decision itself is reachable and tested; only the
`?? ''`/`?? null` fallbacks are not (smtp-server's PLAIN and LOGIN mechanisms,
`lib/sasl.js`, always normalise `username`/`password` to a string, even an
empty one, before `onAuth` is called — undefined is not a value either
mechanism hands this callback, only the TypeScript type says so).

`verifyTenant` runs scrypt off the event loop (`crypto.ts`'s `verifyApiKey`,
async since it's on this request path) — awaited rather than left as a
floating promise so a store/crypto error reaches smtp-server's own
callback-based error handling as a credential failure, not an unhandled
rejection.

## Recipients

### Recipient count

smtp-server calls `onRcptTo` BEFORE pushing the address onto
`session.envelope.rcptTo` (verified from its source), so this length is
exactly the count of recipients already accepted for THIS message — the cap
refuses the `(maxRecipientsPerMessage + 1)`th and later, leaving every
earlier one accepted, rather than rejecting the whole message.
`session.envelope` is replaced wholesale by smtp-server on every
RSET/EHLO/HELO and after each completed DATA, so this count is per-message,
never cumulative across a connection's lifetime. A temporary failure (RFC
5321): the limit is this listener's own local policy, not a statement that
the address can never be delivered to.

## Header sender-binding

### Header sender-binding control

The header half of the sender-binding control runs in `onData`. `onMailFrom`
already bound the envelope to this tenant, but a message's VISIBLE identity
is its header From (and, if present, Sender) — a header this front door
parses only now, from the body it is still holding, so this is the earliest
point either can be checked. Only enforced when the header is actually
present: a message with no header From at all displays the already-verified
envelope address instead, so there is nothing left to spoof. Refused before
`enqueueBatch`/`callback` — never a 250 for a message that is then dropped.
`session.tenantSenderDomain` is guaranteed non-null at this point: this is
the SAME message `onMailFrom` already ran its own `resolveSenderDomain` gate
for (MAIL FROM always precedes DATA in the SMTP state machine, and
`onMailFrom` refuses the whole message before RCPT/DATA can run if that gate
fails) — never re-derived or re-checked, just trusted.

### Header injection refusal

The From/Subject/Reply-To check refuses, never strips: the HTTP route
(`mailgunFields.ts`'s `containsHeaderInjectionChars`) refuses outright on the
same three characters, and a message this front door has already decided to
enqueue should give this connection the same definite, checkable outcome — a
550 the sender's own MTA can act on — rather than accepting a message whose
displayed From/Subject/Reply-To silently differs from what was submitted.
mailparser has already run its own MIME decoding by this point
(`simpleParser`, earlier in the same handler), so this also catches an
encoded-word that decodes to a CRLF or NUL never literally present on the
wire — for example, a Subject of `=?utf-8?Q?a=0D=0ASender:_ceo@evil.com?=`
decodes to a second, injected header line.

### Sender is never taken from the tenant

Sender is never taken from the tenant, on this route either — stripped, not
validated-then-refused. A submitted header Sender (any value, matching or
not) is simply never copied into `headers`, which only ever carries
Reply-To — so it never reaches nodemailer and never reaches the delivery
host, and there is nothing left here worth inspecting first. The alternative
this route could have taken instead — parsing the header and refusing the
message on a mismatch, the way the HTTP route's now-removed `h:Sender` check
used to — was rejected: that value was already never relayed either way
(this route builds its own `headers` object rather than forwarding
mailparser's parsed headers wholesale), so checking it bought no protection,
only a second place a parsing difference between mailparser and nodemailer's
own normalisation could reopen a bypass, which is exactly the structural
problem the HTTP-side fix (in the HTTP route) exists to close.

## Test rationale

### Test: pool guard counters

`createUnauthenticatedPoolGuard` describe block: filtering smtp-server's own
`connections` Set counts a connection from the instant its TCP handshake
completes, not from the instant this guard would have admitted it —
smtp-server holds every accepted socket for a fixed ~100ms "early talker"
delay before its `onConnect` hook even runs. A burst of connections from one
source therefore all land in that Set together, all still pending their own
admission check, and a filter over the Set counts every one of them as if
already admitted. This guard's own counters increment only on a `tryAcquire`
that itself returns admitted — never from anything outside its control — so a
burst can never inflate its counts beyond what it actually let through,
regardless of how many raw sockets are simultaneously open.

### Test: queue reentrancy

The "if the guard itself refuses the immediate re-acquire..." test uses a
hand-rolled guard, not the real one: scripted to admit the first call for a
source and then refuse every call after, so this proves the queue's own
reentrancy defence — not a real race, which single-threaded JS makes
impossible between a `release()` and the queue's own very next line, but a
guarantee the queue does not rely on that impossibility silently. Call 1 (the
first request's own immediate check): admits. Call 2 (the second request's
own immediate check): refuses per-source, so the queue holds it rather than
refusing it outright. Call 3 (the re-acquire the queue itself makes when the
first slot releases): refuses on the GLOBAL reason — standing in for
"something else took the last global slot in between" — which is the case
this test exists to prove the queue survives without dropping the waiter.

### Test: concurrent churn

"a genuine concurrent burst from one source... still never blocks a different
source": the sequential test above it proves the cap logic; it does not prove
the WIRING survives real concurrency. smtp-server adds every accepted socket
to its own `connections` Set the instant the TCP handshake completes, then
holds it — unchecked by anything — for a fixed ~100ms "early talker" delay
before `onConnect` ever runs (`connectionReady()`, `smtp-connection.js`). A
live churn attack that opens many connections from one source at once, not
one at a time, lands a burst of them in that Set together, all still pending
their own admission check — which is exactly what defeated the first version
of this fix (proven against real Ghost 6.55.0: a single churning source
pinned the global count above its cap using connections that were themselves
about to be refused, and a different, well-behaved source got a real 421).
Firing many connects here without awaiting each one in turn is what actually
exercises that window.

### Test: legitimate burst

"a legitimate concurrent burst from ONE source... every send completes": the
exact shape ordinary traffic produces, not an attack — several members
signing in at once each open their own connection from the same host. A
per-source cap that refuses anything past its own number turns that into
lost mail. Twenty concurrent sends from one source, cap held at 5, must all
still complete — the excess waits for the ordinary trickle of releases (each
one authenticating) rather than being turned away.

`maxUnauthenticatedPerSourceWaitMs` is set explicitly in this test, well past
the harness default of 2000ms, rather than left to it. What this test asserts
is a correctness property — all 20 sends eventually complete, none refused —
not that they do so within some particular wall-clock window, and the
harness default was never chosen with that property in mind. Even with
AUTH's scrypt check off the event loop (`crypto.ts`), the wait a queued
connection can tolerate before every earlier one has authenticated still
scales with real CPU time, which this suite does not control. 10s is
comfortably under nodemailer's own default greeting timeout, so it changes
nothing about what a real client would tolerate.

### Test: eviction deadline

"an authenticated submission succeeds once idle, never-authenticating
connections holding the pool have been evicted by their deadline": the
finding this defends against is an unauthenticated peer holding every
unauthenticated slot, so a real submitter's own (initially unauthenticated)
connection is refused at the greeting before it ever gets to try AUTH. Fixed
by a deadline short enough that the attacker's slots free up well within the
time a real client would retry. A generous deadline relative to this test's
own connection setup time (each connect is a real TCP round trip): short
enough to still prove eviction happens well within a real client's retry
window, long enough that the attacker connections are reliably both open
before either gets evicted, which is what "pool full" needs.

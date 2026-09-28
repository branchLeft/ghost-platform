# smtpFrontDoor.ts

## createUnauthenticatedPoolGuard

Deliberately its own counters, not a filter over smtp-server's own
`connections` Set. smtp-server adds every accepted socket to that Set the
instant it accepts the TCP connection, then holds it for a fixed ~100ms
("early talker" detection, connectionReady() in smtp-connection.js)
before this guard — inside the onConnect hook — ever runs on it. A
connection still in that dwell window has not been admitted by anything
yet, but a filter over the Set counts it anyway: a single source
churning connections fast enough keeps a rolling ~150-wide window of
such not-yet-checked connections permanently present, which pinned the
global count above its cap using connections that were themselves about
to be refused a moment later — starving a legitimate connection from a
different source thanks to the very source the cap exists to contain.
Counting only what this guard itself has let through removes the race:
a connection counts here from the instant it is admitted until this
guard's own `.release()` is called, never from mere socket acceptance.

## createUnauthenticatedAdmissionQueue

Several members signing in at once each open their own connection from
Ghost's one source address, and scrypt's ~21ms per AUTH check runs
serially, so more than the per-source cap's worth can be genuinely
unauthenticated at the same instant — a burst refused outright loses
real magic links to a `500`, not an attack. A cap sized to refuse
nothing would just move the same problem to a larger number reached by
a large-enough legitimate burst.
Queueing instead means a burst past the per-source cap waits — bounded
in both how many can wait and how long — for the ordinary trickle of
releases (a queued connection's own eventual AUTH, or another
connection from the same source closing) to admit it, rather than
refusing it outright. The global cap is never queued behind: it is the
backstop for many distinct hostile sources at once, a different threat
this queue does nothing about and should not soften.

## RawSmtpConnection

`smtp-server`'s own connection objects, as held in `SMTPServer.connections`
(typed `Set<any>` upstream) — narrowed to exactly what's needed to tell an
authenticated connection from an unauthenticated one, group connections by
source address, end one that has overrun its auth deadline, and release a
DATA phase's concurrency slot when the underlying socket closes without
the data stream itself ever emitting `end` or `error` (verified from
source: `_onClose`, smtp-connection.js, unpipes and nulls the data stream
on socket close without emitting on it). `session` here is the same
object instance `onAuth` mutates, so `.session.user` reflects live auth
state, and `_socket` is the real underlying `net.Socket` — private to
smtp-server, but real, and the only place a mid-transfer disconnect is
ever observable from outside it.

## createSmtpFrontDoor

The listener Ghost's transactional sender connects to (LLD-6 §01-§03):
a durable local write, answered at once, with nothing awaited past the
SQLite transaction that makes the message durable. It shares
`enqueueBatch`/`claimDueRecipients` with the Mailgun-shaped HTTP route
(routes/messages.ts) — one queue, two front doors, exactly the LOAD-BEARING
shape LLD-6 §03 sets out.

`wake.notify()` below is fire-and-forget by its own contract (drainWake.ts) —
nothing here awaits a network hop, which is the whole property this
component exists to hold.

## Per-source before global

Per-source is checked before global inside the guard itself: one
source address (e.g. a compromised, credential-less container) can
never occupy more than its own instantly-admitted share of the
pool, however fast it churns connections — replacing each one the
instant it's refused or evicted defeats a purely time-based
deadline (reconnect faster than it) and doesn't need to spread
across addresses to defeat a purely global count-based cap. The
global cap is the backstop, sized well past what the per-source
cap alone would ever let one source reach, so it should never be
the binding limit for a single well-behaved source. A legitimate
burst past the per-source cap does not get refused outright: it
waits, bounded, for the ordinary trickle of releases from that same
source — see createUnauthenticatedAdmissionQueue's own comment.

## Authentication

The username IS the submitter's identity (a per-tenant/per-slot
domain, same shape as the Mailgun HTTP route's tenant key) — a
submission is never trusted because of where it came from or what
address it claims to send as. This credential decision itself is
reachable and tested; only the `?? ''`/`?? null` fallbacks below are
not (smtp-server's PLAIN and LOGIN mechanisms, lib/sasl.js, always
normalise `username`/`password` to a string, even an empty one,
before onAuth is called — undefined is not a value either mechanism
hands this callback, only the TypeScript type says so).

verifyTenant runs scrypt off the event loop (crypto.ts's
verifyApiKey, async since it's on this request path) — awaited
rather than left as a floating promise so a store/crypto error
reaches smtp-server's own callback-based error handling as a
credential failure, not an unhandled rejection.

## Recipient cap

smtp-server calls onRcptTo BEFORE pushing the address onto
session.envelope.rcptTo (verified from its source), so this length
is exactly the count of recipients already accepted for THIS
message — the cap below refuses the (maxRecipientsPerMessage+1)th
and later, leaving every earlier one accepted, rather than
rejecting the whole message. session.envelope is replaced wholesale
by smtp-server on every RSET/EHLO/HELO and after each completed
DATA, so this count is per-message, never cumulative across a
connection's lifetime. A temporary failure (RFC 5321): the limit is
this listener's own local policy, not a statement that the address
can never be delivered to.

## Releasing the DATA slot on close

The slot must also be released if the underlying connection closes
before the stream reaches 'end' or 'error' — smtp-server detaches
the stream (unpipes it and sets it to null, smtp-connection.js
_onClose) without emitting on it when the socket closes mid-DATA,
so relying on the stream's own events alone leaks the slot forever
on every dropped connection, not only a deliberately malicious one:
an ordinary network blip or container restart mid-send does this.
`_socket` is smtp-server's real underlying net.Socket; its own
'close' event fires in every case a TCP connection ends, however it
ends. `.once()` self-removes once fired; the two calls below remove
it on the other two paths instead, so a connection sending many
messages in one session doesn't accumulate one listener per message.

## Header From and Sender

The header half of the sender-binding control. onMailFrom above
already bound the envelope to this tenant, but a message's
VISIBLE identity is its header From (and, if present, Sender)
— a header this front door parses only now, from the body it
is still holding, so this is the earliest point either can be
checked. Only enforced when the header is actually present:
a message with no header From at all displays the
already-verified envelope address instead (see the
`from` fallback below), so there is nothing left to spoof.
Refused before enqueueBatch/callback below — never a 250 for
a message that is then dropped.
session.tenantSenderDomain is guaranteed non-null here: this
is the SAME message onMailFrom already ran its own
resolveSenderDomain gate for (MAIL FROM always precedes DATA
in the SMTP state machine, and onMailFrom refuses the whole
message before RCPT/DATA can run if that gate fails) — never
re-derived or re-checked, just trusted.

## Refuse, never strip

Refuses, never strips: the HTTP route (mailgunFields.ts's
containsHeaderInjectionChars) refuses outright on the same
three characters, and a message this front door has already
decided to enqueue should give this connection the same
definite, checkable outcome — a 550 the sender's own MTA can
act on — rather than accepting a message whose displayed
From/Subject/Reply-To silently differs from what was
submitted. mailparser has already run its own MIME decoding
by this point (simpleParser, above), so this also catches an
encoded-word that decodes to a CRLF or NUL never literally
present on the wire — for example, a Subject of
`=?utf-8?Q?a=0D=0ASender:_ceo@evil.com?=` decodes to a
second, injected header line.

## Sender is stripped, not validated

Sender is never taken from the tenant, on this route either —
stripped, not validated-then-refused. A submitted header
Sender (any value, matching or not) is simply never copied
into `headers` below, which only ever carries Reply-To — so
it never reaches nodemailer and never reaches the delivery
host, and there is nothing left here worth inspecting first.
The alternative this route could have taken instead —
parsing the header and refusing the message on a mismatch,
the way the HTTP route's now-removed h:Sender check used to —
was rejected: that value was already never relayed either
way (this route builds its own `headers` object rather than
forwarding mailparser's parsed headers wholesale), so
checking it bought no protection, only a second place a
parsing difference between mailparser and nodemailer's own
normalisation could reopen a bypass, which is exactly the
structural problem the HTTP-side fix above exists to close.

## The data stream never errors

The data stream's `error` handler is unreachable today, which was checked
against smtp-server's own source rather than assumed: nowhere in the library
does anything call `.emit('error', ...)` or `.destroy(...)` on the data stream
(a search of the whole package finds none). A socket error during the
transaction (ECONNRESET/EPIPE with `session.envelope.mailFrom` set) is emitted
on the connection (`this.emit('error', err)`, smtp-connection.js `_onError`),
never forwarded to the stream; the same error outside a transaction goes
through `_onClose` instead, which is the path the connection `close`-based
release defends (see [releasing the DATA slot on close](#releasing-the-data-slot-on-close)).
The handler is kept as a fail-closed guard against a future smtp-server
version starting to emit there, not because any input today can reach it.

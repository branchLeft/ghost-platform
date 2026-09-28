# smtpFrontDoor.test.ts

## The guard's own counters

Filtering smtp-server's own `connections` Set counts a connection from
the instant its TCP handshake completes, not from the instant this
guard would have admitted it — smtp-server holds every accepted socket
for a fixed ~100ms "early talker" delay before its onConnect hook even
runs. A burst of connections from one source therefore all land in
that Set together, all still pending their own admission check, and a
filter over the Set counts every one of them as if already admitted.
This guard's own counters increment only on a tryAcquire that itself
returns admitted — never from anything outside its control — so a
burst can never inflate its counts beyond what it actually let
through, regardless of how many raw sockets are simultaneously open.

## A scripted guard

A hand-rolled guard, not the real one: scripted to admit the first
call for a source and then refuse every call after, so this proves
the queue's own reentrancy defence — not a real race, which
single-threaded JS makes impossible between a release() and the
queue's own very next line, but a guarantee the queue does not rely
on that impossibility silently.
Call 1 (the first request's own immediate check): admits. Call 2
(the second request's own immediate check): refuses per-source, so
the queue holds it rather than refusing it outright. Call 3 (the
re-acquire the queue itself makes when the first slot releases):
refuses on the GLOBAL reason — standing in for "something else took
the last global slot in between" — which is the case this test
exists to prove the queue survives without dropping the waiter.

## Concurrent churn

The sequential test above proves the cap logic; it does not prove
the WIRING survives real concurrency. smtp-server adds every
accepted socket to its own `connections` Set the instant the TCP
handshake completes, then holds it — unchecked by anything — for a
fixed ~100ms "early talker" delay before onConnect ever runs
(connectionReady(), smtp-connection.js). A live churn attack that
opens many connections from one source at once, not one at a time,
lands a burst of them in that Set together, all still pending
their own admission check — which is exactly what defeated the
first version of this fix (proven against real Ghost 6.55.0: a
single churning source pinned the global count above its cap using
connections that were themselves about to be refused, and a
different, well-behaved source got a real 421). Firing many
connects here without awaiting each one in turn is what actually
exercises that window.

## A legitimate burst

The exact shape ordinary traffic produces, not an attack: several
members signing in at once each open their own connection from the
same host. A per-source cap that refuses anything past its own
number turns that into lost mail. Twenty concurrent sends from one
source, cap held at 5, must all still complete — the excess waits
for the ordinary trickle of releases (each one authenticating)
rather than being turned away.

maxUnauthenticatedPerSourceWaitMs is set explicitly here, well
past the harness default of 2000ms, rather than left to it. What
this test asserts is a correctness property — all 20 sends
eventually complete, none refused — not that they do so within
some particular wall-clock window, and the harness default was
never chosen with that property in mind. Even with AUTH's scrypt
check off the event loop (crypto.ts), the wait a queued
connection can tolerate before every earlier one has authenticated
still scales with real CPU time, which this suite does not
control. 10s is comfortably under nodemailer's own default
greeting timeout, so it changes nothing about what a real client
would tolerate.

## The auth deadline

The finding this defends against: an unauthenticated peer holds
every unauthenticated slot, so a real submitter's own (initially
unauthenticated) connection is refused at the greeting before it
ever gets to try AUTH. Fixed by a deadline short enough that the
attacker's slots free up well within the time a real client would
retry.
A generous deadline relative to this test's own connection setup
time (each connect below is a real TCP round trip): short enough to
still prove eviction happens well within a real client's retry
window, long enough that the attacker connections are reliably both
open before either gets evicted, which is what "pool full" needs.

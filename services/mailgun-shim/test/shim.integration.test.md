# shim.integration.test.ts

## rawDrainOnce

Reads `GET /drain` directly, the same real route the production collector
will eventually poll, but without also routing the result through
nodemailer's own rendering (`collector.ts`'s `drainOnce`) — a collector
that renders via nodemailer happens to mask a raw `headers.From` (or a
CRLF-carrying value) surviving into the wire payload, because
nodemailer's own `setHeader` overrides a custom `From` and folds a bare
CRLF when it later builds the outgoing message. Proving the drain
payload itself is clean — independent of whatever eventually consumes it
— is the point of the tests that use this helper. Never acks, so it
never competes with `collector` for the same row within one test.

## The real client and collector

mailgun.js is the exact client library Ghost bundles
(mailgun-client.js:367-370 constructs it the same way: `new
Mailgun(formData)`, then `.client({username, key, url, timeout})`).
Driving the shim through this library rather than hand-building
multipart requests means the test exercises the real wire format, not a
guess at it.

The collector (test/helpers/collector.ts) plays the part LLD-6 gives to
mx1 or ops1: it is the only caller that ever reaches GET /drain
and POST /drain/ack, over the shim's real HTTP routes, delivering
against a real SMTP listener (smtpSink.ts) standing in for the delivery
host. Nothing here mocks the drain contract itself.

## A recipient token in Sender

A %recipient.*% token in a Sender header, resolved AFTER a per-request
check, used to be able to reach the recipient with a foreign address in
either the local part or the display name — the check approved the
unresolved token string, and substitution then turned it into something
the check never saw (token resolution happens in routes/drain.ts's
toWireMessage now, the direct successor of the deleted worker.ts's
processRow). Dropping Sender unconditionally at intake closes this by
construction: the value (token or not) is never stored, so it is never
a candidate for token resolution in the first place. Spelled
`h:sender` (lower-case) deliberately — this is the one spelling
toWireMessage does NOT special-case for an already-queued legacy row
(it only keeps Ghost's own exact `Sender`), so these two tests are a
genuine proof of the intake drop specifically, not of that narrower
fallback.

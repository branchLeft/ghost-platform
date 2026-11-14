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

## Per-slot credential domains

render-core renders a demo slot's spool credential as
`slot-<uid>.<demoMailDomain>` (render-core/src/mail.md#credential-domain),
while every slot sends from the one `<demoMailDomain>`. The shim already holds
the two apart: `tenants.domain` is the credential domain both front doors
authenticate against, and `tenants.sender_domain` is what From is bound to, with
`tenants.sender_local_part` binding it to the one slot's address. So the
isolation proof is one row per slot, one shared `--sender-domain`, and one
`--sender-local-part` each.

The CONTROL case registers a single shared row for a demo host and
shows slot B's send is accepted with the key slot A holds, on the Mailgun route
and over SMTP. That is what makes the isolation case meaningful: the same
harness, the same sends, and only the row layout differs. The isolation case
then asserts A's key gets 401 on B's credential domain on the Mailgun route and
an EAUTH refusal on SMTP AUTH, queues nothing, and that each slot's own key
still sends. The rotation case replaces slot A's row and shows B's key is
untouched.

The `From local part is bound to the slot` cases then register one row per
slot with its own local part and show that a slot's own credential cannot send
as another slot's address: on the Mailgun route (400, nothing queued), at SMTP
MAIL FROM (553), and in the SMTP header From when the envelope sender is the
slot's own (550). A longer, prefixed or dotted variant of the slot's address is
refused, a case variant of its own address is accepted, and each slot's own
address sends on both front doors.

The `two slots cannot hold one key` case shows registration refusing slot B's row
for a key slot A holds (`TenantRegistrationRefused`), so slot A's key never
authenticates against B's credential domain on either front door. The other
refusals (an overlapping sender address, legacy rows, the CLI messages) are
proven against the store in `test/unit/storeSenderBinding.test.ts` and
`test/unit/cli.test.ts`.

The CONTROL case above registers the one shared row directly because it
reproduces the layout the per-slot rows replace. Two unbound rows on one sender
domain can no longer be registered. All keys are test values.

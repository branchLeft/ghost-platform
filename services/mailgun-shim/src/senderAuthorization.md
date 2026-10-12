# senderAuthorization.ts

## senderBelongsToTenant

The one check both the HTTP route (`routes/messages.ts`, the `from`
field) and the SMTP front door (`smtpFrontDoor.ts`, envelope MAIL FROM,
header From, header Sender) use to decide whether a claimed sender
belongs to a tenant. `tenantDomain` must be the tenant's registered
*sending* domain (`Tenant.senderDomain`), never its credential lookup
key (`Tenant.domain`) — the two are not guaranteed equal (tenant zero's
credential key is `blog.branchleft.co.uk`, its real From is
`branchleft.co.uk`), and passing the wrong one here refuses every
legitimate send instead of every spoofed one.

Exact, case-insensitive equality on the normalised domain — never a
suffix or `endsWith` check. A suffix match would let
"attacker-tenant.com" through against a stored domain "tenant.com"
(it ends with "tenant.com" the wrong way) and would also have to be
anchored on a label boundary to avoid the opposite mistake
("tenant.com.evil.com" ends with "evil.com", not "tenant.com", so that
particular pair is safe either way — but a same-registrable-suffix
design generally needs a public-suffix list to be safe at all). Equality
alone defeats every look-alike without one, whatever granularity a
tenant's sender domain was registered at (a bare apex, or a subdomain
carved out for one sending purpose).

A header naming more than one mailbox (a From with several addresses)
must have ALL of them belong, not just one — Ghost never legitimately
sends a multi-address From, and a mix of a real address with a spoofed
one is exactly the shape that would otherwise slip through.

An empty, null, or unparseable value never belongs to anything — there
is no address to have been provisioned for a tenant, so "couldn't
parse" is refused exactly like "parsed to something foreign", not
treated as harmless because nothing definite was found.

## boundSender

The HTTP route's form of the same check: it makes the decision
`senderBelongsToTenant` makes and returns the value to queue, or null
when the sender does not belong. The value is what the gate itself
read, re-serialised in the shape Ghost sends (a present display name
always double-quoted with backslash and quote escaped, a bare address
when there is none), not the raw string the tenant submitted.

The raw string is not safe to queue even after it passed. The queue
hands it on unchanged and the collector composes the outgoing message
with its own copy of nodemailer's parser. Two parser versions disagree
about a comment inside a domain, a quoted local part followed by a
comment, and an escaped parenthesis that closes a comment early; the
version the gate runs may then name the tenant while the version that
composes the message names another domain. Shipping the gate's reading
removes the second parse, so the two cannot differ.

The serialised value is read back through the same parser and must
name the same mailboxes (same addresses, same cleaned names); a value
whose normal form is itself ambiguous is refused, not shipped. A
control character in a display name is folded to a space, so the name
always sits inside one quoted string.

The domain of each mailbox is queued as it was compared: lower-cased,
trailing dots stripped, IDN labels in their punycode form, never the
spelling that was submitted. A local part holding whitespace or a
control character is refused, because a long header line is folded at
whitespace.

The SMTP front door uses it too: the MAIL FROM gate, the header From it
checks, and the envelope sender it queues for a message with no header
From are all this function's result, in the same normal form as the
HTTP route.

## Domains are compared as hostnames

A domain is compared as a hostname. After trailing dots are stripped,
an ASCII character that is not a letter, digit, hyphen, dot or
underscore refuses the whole value, as does a normalised result that is
not a plain hostname. Non-ASCII labels are still accepted and compared
in their punycode form.

## resolveSenderDomain

The single fail-closed gate both front doors call, exactly once per
submission, before any `senderBelongsToTenant` check runs. A tenant
with no registered sender domain — every row that predates this field,
until an operator runs the CLI's `set-sender-domain` — is refused here
rather than silently falling back to `tenant.domain` (the credential
key): the two are not guaranteed equal (see `Tenant.senderDomain`'s own
doc comment), and guessing one back in for a legacy row would
reintroduce that mismatch, one row at a time, as new tenants migrate in
unset.

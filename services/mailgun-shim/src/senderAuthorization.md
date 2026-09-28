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

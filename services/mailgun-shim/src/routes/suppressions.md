# suppressions.ts

## The suppressions path

The real endpoint has no literal "suppressions" path segment — verified
by instrumenting mailgun.js's Suppressions#destroy, which the Ghost
client calls as `instance.suppressions.destroy(domain, type, email)`
(mailgun-client.js:280): it builds
`DELETE /v3/{domain}/{bounces|complaints|unsubscribes}/{email}` directly,
with `type` as the literal second path segment. Doc 13's own §1.3 table
has this right; a later summary of it drifted to
"/v3/{domain}/suppressions/{email}", which this route does not implement
because Ghost's real client never sends that URL.

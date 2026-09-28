# cli.ts

## Hostname pattern

A plain lowercase hostname: DNS labels only, at least one dot (a bare
TLD is never a real sending domain here), no scheme, no `@`, no
whitespace. Deliberately stricter than `senderAuthorization.ts`'s
`normalizeDomain` (which IDN-normalises and lowercases *for* a caller) —
this is the operator-input gate, where a typo should be refused outright
rather than silently coerced. A typo'd sender domain here does not fail
loudly at registration time otherwise: `senderBelongsToTenant` would
just refuse every real send against it later, which reads as the
sender-binding control being broken, not as a bad CLI argument.

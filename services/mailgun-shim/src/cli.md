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

## Local part pattern

A From local part the shim can bind a credential to: the shape render-core
accepts for a demo's local part (letters, digits, dot, underscore, hyphen; no
leading or trailing punctuation; at most 64 characters). Refused, not coerced,
like the hostname pattern above: a typo'd local part would otherwise surface as
every real send being refused. Case is kept as typed; the store compares it
lower-cased (store.md#sender-local-part).

## Registration refusals

`register`, `set-sender-domain` and `set-sender-local-part` report a refused
registration (store.md#registration-refusals) on stderr, exit 1, and print no
key: `register` generates the key before it asks the store, but only writes it to
stdout after the store has accepted the row. The message names the credential
domain in the way, never a key.

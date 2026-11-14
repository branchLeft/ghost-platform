# cli.ts

## Hostname pattern

A plain lowercase hostname: DNS labels only, at least one dot (a bare
TLD is never a real sending domain here), no scheme, no `@`, no
whitespace. Deliberately stricter than `senderAuthorization.ts`'s
`normalizeDomain` (which IDN-normalises and lowercases _for_ a caller) —
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

## Remove

`remove <credential-domain> --confirm <credential-domain>` deletes one
credential row, so the credential domain can be retired (a shared row once
every slot has its own, or a demo slot's row once the slot is reset) without
a hand-written script against the SQLite file.

Deleting a row is the one verb here whose slip locks a live sender out:
every send under that domain gets the same 401 as a wrong key, and a
tenant's own row (tenant zero's included) is deleted exactly as a slot's is.
It is therefore guarded the way `register --rotate` guards a re-key, only
harder, because there is no old key to fall back on:

- both arguments are plain lowercase hostnames, in exactly that order, with
  nothing after them (a flag in the domain slot, `--confirm` first, an extra
  trailing flag and a missing value are all refused with the usage line);
- `--confirm` must repeat the domain exactly, so a pasted line naming one
  domain cannot remove another. A mismatch removes nothing;
- the row must exist (a typo is an error, not a quiet success);
- it prints the sender domain it removed, so the operator sees what went.

It deletes the `tenants` row and nothing else: the domain's events,
suppressions and already-queued mail stay, and queued mail still drains.
Purging those on a slot's reset is separate work. Re-registering the same
domain afterwards needs no `--rotate` and issues a new key; the removed key
stays dead. Nothing prints a key.

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

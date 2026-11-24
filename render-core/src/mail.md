# mail.ts

## Sending address

The one email address Ghost sends member mail *as* — computed once here and
handed to both `settings.ts` (`members_support_address`, the setting
Ghost's members API actually reads before it sends a magic link) and
`environment.ts` (`mail__from`, the config key that looks like the right one
and is not). The trap this closes: a sender restriction upstream rejects
the two disagreeing as an opaque HTTP 400 on a magic link, with the real
error only in container output. Computing the address exactly once, rather
than in each renderer separately, makes the two disagreeing a compile error
away from possible rather than merely a case a test happens to cover.

## Credential domain

The identity a Ghost authenticates to the host's mail spool as, on both of the
spool's front doors: the Mailgun route's URL domain
(`bulkEmail__mailgun__domain`) and the SMTP username
(`mail__options__auth__user`). One value, `credentialDomainOf`, feeds both.

**Decision (recorded in the private tracker).** A demo slot's credential domain is
`slot-<uid>.<zones.demoMailDomain>`. A paying tenant's stays its own sending
domain, so this change leaves a tenant's rendered output unchanged.

- **Keyed on the uid.** The uid is the stable per-slot identity: the spool's
  per-slot network already keys on it, a demo's slug changes every lease, and a
  uid is digits (30000 to 30999), so the label is always DNS-safe.
- **Under `demoMailDomain`.** `validate()` already refuses a tenant domain equal
  to or under it, so a slot credential can never collide with a tenant's.
- **The sending domain does not move.** `mail__from`, `members_support_address`
  and DKIM stay `<localPart>@<demoMailDomain>` (a local part per demo, not a
  subdomain per demo). Only the credential identity moves.
- **One shim row per slot.** The shim keys a credential on `tenants.domain` and holds
  the sending domain apart in `tenants.sender_domain`. One row per slot, every
  row with `--sender-domain <demoMailDomain>`, maps each slot credential back to
  the shared sender domain.
- **What it buys.** A slot's key authenticates only its own credential-domain
  row, so it cannot submit as another slot, and rotating one slot's key leaves
  the others valid. A per-credential ceiling and a purge of one lease's queue on
  recycle can now key on that row.
- **Cost.** None. A naming change and one extra row per slot in the existing
  spool.

**The shim binds the From local part and refuses a shared key.** Register each
slot's row with `--sender-local-part <localPart>` (the descriptor's
`mail.identity.localPart`): the shim then refuses a send from that credential as
any other address at `<demoMailDomain>` (the shim's `0003_sender_local_part`
migration; see its `src/store.md#sender-local-part`), and registration refuses a key already bound to another credential and a second
row for an address another row holds.

**Not decided here.** Key rotation on recycle (`register --rotate`) is operator
and broker discipline, not rendered. The per-credential ceiling and the lease
purge are shim work that consumes this key.

**Rollout order.** Register each `slot-<uid>.<demoMailDomain>` row with
`--sender-domain <demoMailDomain> --sender-local-part <localPart>` and write its
key to that slot's `/etc/branchleft/<slug>.env` as `GHOST_BULK_EMAIL_API_KEY` before deploying a
build that carries this change. A slot rendered with the new username before
its row exists gets 401 on every send.

## Mail route

`mail.route` says which sending target the mail collector uses for a host's
drained mail: `{ primary: "mx1" | "sweego", sweegoAllowance?: integer }`. It is
optional, and an absent route means `mx1`, so every descriptor written before
the field existed means exactly what it always did. `mailRouteOf` is the one
place that default lives.

- **Strict.** The object takes `primary` and `sweegoAllowance` and nothing
  else. A bare string, an unknown target, a fallback or exception key, or a
  missing `primary` is refused by `validate()` as a malformed field. There is
  no field that could name a fallback: the collector's fallback is fixed in
  its code.
- **The allowance.** `sweegoAllowance` is the tenant's messages per UTC
  calendar month through Sweego, a positive integer of at most
  `MAX_SWEEGO_ALLOWANCE`. It is required when `primary` is `sweego` and
  refused when it is `mx1`, so a route never carries a number nothing counts
  against. The collector counts against it and latches the tenant at 100
  percent until month end.
- **A demo stays on mx1.** A demo whose route is `sweego` is refused as a tier
  mismatch, the same way a demo carrying a DKIM selector is.
- **`render()` ignores it.** `render()` emits no artefact that mentions the
  route, so a tenant host receives byte-identical output whatever its value
  (`test/mailRoute.test.ts`). The collector reads the route and the allowance
  from the descriptor; the counts themselves are collector state, never
  descriptor data. The one other reader is the host's mail spool, which a
  Sweego route opts into `SHIM_DRAIN_OUTCOMES`
  (`mailSpoolNeedsDrainOutcomes`; see spool.md#the-outcomes-route).
- **No credential or host.** The allowance is a plain number. The plan size
  and the account-wide cap are not descriptor fields.

## Bulk endpoint

`mail.bulk` says where Ghost's bulk-mail client submits newsletters:
`{ endpoint, domain, credentialRef }`. It is optional, and an absent `bulk`
means the host's own mail spool, so every descriptor written before the field
existed renders exactly what it always did (golden: `test/bulkMail.test.ts`).
No provider is named anywhere in the key names, the rendered config or the code.

- **`endpoint`** is an https origin: scheme, host and an optional port, with no
  userinfo, path, query, fragment or trailing slash. It renders as
  `bulkEmail__mailgun__baseUrl`. The key names stay as Ghost reads them.
- **`domain`** is the account identifier Ghost addresses on that endpoint, and
  renders as `bulkEmail__mailgun__domain`. Absent `bulk`, it is the spool's
  credential domain (`credentialDomainOf`), as before.
- **`credentialRef`** is the *name* of the secrets-file key that holds the
  credential, `GHOST_BULK_` then 1 to 48 upper-case letters, digits or `_`. The
  key renders as the usual `${NAME:?set NAME in <secrets file>}` reference in
  `bulkEmail__mailgun__apiKey`, and `renderSecretsTemplate` lists it in place of
  `GHOST_BULK_EMAIL_API_KEY`. The value never appears in the descriptor, in any
  artefact, or in a test.
- **A paying tenant with an SMTP transport only.** A demo is refused (a tier
  mismatch), and so are `mail.enabled: false` (no bulk key is rendered) and a
  `queue` transport, which sends all of a tenant's mail through the spool and
  uses the spool's one key; a second endpoint would split one path across two.
- **The transactional path is separate.** `transport` (`smtp`) already names
  the host, port and login for member mail, with the password as
  `GHOST_MAIL_PASSWORD`. `bulk` is the same idea for newsletters.
- **Strict.** The object takes `endpoint`, `domain` and `credentialRef` and
  nothing else; a stray key such as a literal credential is refused.

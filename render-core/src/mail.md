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

**Decision (workspace#1740).** A demo slot's credential domain is
`slot-<uid>.<zones.demoMailDomain>`. A paying tenant's stays its own sending
domain, so a tenant's rendered output is byte-identical to before.

- **Keyed on the uid.** The uid is the stable per-slot identity: the spool's
  per-slot network already keys on it, a demo's slug changes every lease, and a
  uid is digits (30000 to 30999), so the label is always DNS-safe.
- **Under `demoMailDomain`.** `validate()` already refuses a tenant domain equal
  to or under it, so a slot credential can never collide with a tenant's.
- **The sending domain does not move.** `mail__from`, `members_support_address`
  and DKIM stay `<localPart>@<demoMailDomain>` (a local part per demo, not a
  subdomain per demo). Only the credential identity moves.
- **No shim change.** The shim keys a credential on `tenants.domain` and holds
  the sending domain apart in `tenants.sender_domain`. One row per slot, every
  row with `--sender-domain <demoMailDomain>`, maps each slot credential back to
  the shared sender domain.
- **What it buys.** A slot's key authenticates only its own credential-domain
  row, so it cannot submit as another slot, and rotating one slot's key leaves
  the others valid. A per-credential ceiling and a purge of one lease's queue on
  recycle can now key on that row.
- **Cost.** None. A naming change and one extra row per slot in the existing
  spool.

**Not decided here.** Binding the From local part to the slot needs a shim
schema change. Key rotation on recycle (`register --rotate`) is operator and
broker discipline, not rendered. The per-credential ceiling and the lease purge
are shim work that consumes this key.

**Rollout order.** Register each `slot-<uid>.<demoMailDomain>` row with
`--sender-domain <demoMailDomain>` and write its key to that slot's
`/etc/branchleft/<slug>.env` as `GHOST_BULK_EMAIL_API_KEY` before deploying a
build that carries this change. A slot rendered with the new username before
its row exists gets 401 on every send.

## Mail route

`mail.route` says which sending target the mail collector uses for a host's
drained mail: `{ primary: "mx1" | "sweego" }`. It is optional, and an absent
route means `mx1`, so every descriptor written before the field existed means
exactly what it always did. `mailRouteOf` is the one place that default lives.

- **Strict.** The object takes `primary` and nothing else. A bare string, an
  unknown target, a fallback or exception key, or a missing `primary` is
  refused by `validate()` as a malformed field. There is no field that could
  name a fallback: the collector's fallback is fixed in its code.
- **A demo stays on mx1.** A demo whose route is `sweego` is refused as a tier
  mismatch, the same way a demo carrying a DKIM selector is.
- **Nothing reads it yet.** `render()` emits no artefact that mentions the
  route, so a tenant host receives byte-identical output whatever its value
  (`test/mailRoute.test.ts`). The collector carries it on its drain target
  and does not act on it.
- **No credential, host or allowance.** A per-tenant allowance is added beside
  `primary` when something counts against it; this change adds none.

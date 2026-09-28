# transform.ts

## Promotion transform overview

The demo-to-tenant promotion transform: "transform() -- five unions +
per-kind scalars". Moves exactly the five unions the design's falsifying
claim names -- `database`, `media`, `hostname`, `gate`, `backup` -- plus
`mail`'s own sending identity (a demo's local-part identity becomes the
tenant's own signed domain, the same re-point every other union gets, never
a value this schema invents) and the three per-kind scalars that are not
unions but still differ by kind: `limits`, `caps`, `expiresAt`. Everything
else on the descriptor, `slug` above all, survives unchanged: promotion is a
re-point of the configuration, never a migration, and the reason a name, a
slug-derived path or a volume identity is exactly what
`assertAttributablePromotionDiff` below rejects.

Six things this function deliberately does not decide, because deciding
them here would be inventing operational or tier policy the design does not
fix:

- Where the tenant's database and media bucket physically live
  (`targets.databaseHost`/`databasePort`/`mediaEndpoint`/`mediaRegion`) --
  no more this package's job to pick than `appHostIp` is (`render()`'s own
  doc comment: this package never derives a host address; a caller
  supplies one).
- The tenant's own backup encryption recipient
  (`targets.backupEncryptionRecipient`) -- a real per-tenant key identity
  assigned once at promotion by whatever process manages that recipient. A
  schema-level transform has no key-generation authority.
- The tenant's own signed sending domain and DKIM selector
  (`targets.mailIdentity`) -- a real domain-verification and DNS fact this
  schema has no way to confirm, the same reasoning
  `backupEncryptionRecipient` above already carries. A missing target here
  is refused by name below, not defaulted.
- The tenant's own mail ceilings, and whether mail is enabled at all
  (`targets.mailEnabled`/`mailCeiling`/`mailEstateCeiling`) -- these,
  alongside the domain and DKIM selector, are part of what a *promoted
  tenant's own* sending identity carries, never something inherited from
  the demo it was recycled from. This repo's own `test/fixtures.ts` already
  models both ceilings as tier-differentiated (`entryTenantDescriptor()`:
  5000/5000; `professionalTenantDescriptor()`: 50000/50000) -- carrying the
  demo's own 20/500 test-send ceiling forward would ship the demo's cap to
  a paying tenant indefinitely.
- The target tier's `limits` (`targets.limits`) -- this repo's own
  `test/fixtures.ts` already encodes a tier-differentiated model here
  (`entryTenantDescriptor()`: capped; `professionalTenantDescriptor()`:
  uncapped), and `environment.ts#hostLimitsEnvironment` renders it straight
  into the Compose environment Ghost reads
  (`config.get('hostSettings:limits')`) -- so a hardcoded value here would
  ship one tier's entitlement to every promotion regardless of what was
  actually bought. There is no tier-neutral default: even "uncapped" is the
  professional tier's own value, not an absence of one.
- `media.resize`/`media.srcsets` (`targets.mediaResize`/`mediaSrcsets`) --
  the same fixtures encode these as tier-differentiated too: whether they
  are on is a tenancy property, not an implementation detail.

`caps` is the one per-kind scalar this function *does* carry over unchanged
from the demo, because it is not tier-differentiated at all:
`descriptor.ts#ResourceCaps` and `runtime.ts`'s own doc comments both state
the container resource ceiling applies identically to every kind -- unlike
`limits`, there is no tier split to preserve here.

## The transform function

Promotes a demo descriptor to a paying tenant descriptor, placement held
fixed: `appHostIp`, `ports` and `uid` are carried over unchanged, supplied
as fixed test input rather than compared -- a caller re-pointing to a
different host or port triple is a placement decision this function does
not make either. `slug` survives unchanged for the same reason: it is the
one field every derived name (the database identity, the media bucket, the
stack directory) is keyed on, and the whole claim under test is that none
of those move.

`demo.hostname` must be `"ours"` -- the only shape a valid demo can carry
(`validate.ts#checkTierVariants`) -- and its `sub` survives unchanged,
re-pointed from the demo zone to the platform zone and ungated: the default
outcome is that a gated random subdomain on the demo domain becomes an
ungated subdomain of `sites.<platform-domain>`. A promotion onto the
customer's own verified domain is a real, separate path this function does
not build: it needs a verification timestamp this schema-level transform
has no way to obtain honestly, so choosing one here would be inventing
policy this module does not own.

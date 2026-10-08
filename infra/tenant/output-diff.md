# output-diff.test.ts

## The reviewed output diff

The story's original Done criterion was byte-identical output for tenant zero
before and after the rewiring. The owner replaced it on 2026-10-03 with a
reviewed, intentional output diff: every changed value is listed and tied to a
ratified decision, and anything untied blocks.

`test/golden/tenant-4.0.0/` is the **before**: the literal output of the
4.0.0 component (the version tenant zero's stack pins), rendered under Pulumi
mocks from the `v4.0.0` tag's `infra/tenant` source with the configuration in
`test/fixtures.ts#tenantZeroEquivalent` expressed as 4.0.0 arguments, and
placeholder secrets. Recorded, not re-rendered at test time, because two
versions of one package cannot both be installed here.

The **after** is this component, given the same configuration as a
descriptor. `test/diff.ts` flattens both sides into paths (the Compose file
parsed, plus its comment lines; the secrets file by key; the identity; the
scalar outputs) and lists every path that was added, removed or changed.
`test/golden/reviewed-output-diff.json` is that list, each entry carrying the
decision it is tied to. The test fails on a change missing from the list, on
a listed change that no longer happens, and on an entry naming no ratified
decision.

## Decisions

- **`blue-green`**: blue/green applies to every kind (LLD-1, render core
  `compose.md#two-services-not-one`). The one `ghost` service becomes
  `ghost-a` and `ghost-b`, publishing the descriptor's `ports.a` and `ports.b`.
  Every `services.ghost.*` value moves to `services.ghost-a.*` unchanged except
  where another decision below changes it, and `ghost-b` is its twin on
  `ports.b`.
- **`scanning-wrapper`**: every tier runs the scanning check and neither may
  be silently unprotected (LLD-7 S1b). `storage__active: S3Storage` and its
  `storage__S3Storage__*` keys become the scanning adapter, wrapping
  `S3Storage`, for each of images, media and files.
- **`mail-spool`**: one mail spool per host serves the Mailgun-shaped API
  (LLD-6 §03), and member mail is sent as the tenant's own sending identity.
  `bulkEmail__mailgun__baseUrl` points at the host spool, not the central
  mail host, and `mail__from` is the render core's sending address. Since
  render core 0.1.1, both colours also join the tenant's own internal network
  to the spool, `branchleft-mail-<uid>`, declared external, and the base URL
  is the spool's service name on it. The owner
  ruled that tenant zero's live switch-over waits until its per-host spool is
  live.
- **`single-renderer`**: the component renders nothing itself (this story's
  Done criterion; LLD-1 §05). Comment-only lines in the Compose and secrets
  headers are now the render core's wording.
- **`render-core-artefact`**: outputs that exist because the render core
  returns seven artefacts, not three: `provisionScript` replaces
  `hostProvisioningCommand`, and `imageEnvFile`, `edgeSiteBlock` and
  `ghostSettings` are new.
- **`owner-address-secret`**: the owner's email address is a person's, so it
  is never a descriptor field a tenant repository commits; it reaches the
  host only in the secrets file (index.md#the-owner-address). The secrets
  file gains `GHOST_OWNER_EMAIL`. 4.0.0 took no owner address at all.

## The slug

The fixture's slug is `zero`, not tenant zero's own. Render core 0.1.0
reserved tenant zero's slug in `RESERVED_STACK_NAMES`, so this component
could not render tenant zero at all; 0.1.1 stopped reserving it, and the
last test in `output-diff.test.ts` now checks that `validateTenantStack()`
accepts it. `naming.md` in this package records why that slug must stay
unreserved. The fixture stays on `zero` because the 4.0.0 baseline was
recorded with it, and the sending domain below still differs.

**The sending domain is a second difference.** The render core refuses a
tenant whose sending domain lies inside a domain the platform owns ("a tenant
signs its own domain"), so the fixture signs `zero-mail.example.test`, and the
4.0.0 baseline was recorded with the same bulk-mail domain. Tenant zero's
real sending domain sits under the platform's own domain, so moving it onto
this component also needs that sending identity settled, not only the slug.

Every other value in the fixture has the same shape as tenant zero's real
configuration, so the diff here is the diff tenant zero will see, apart from
the slug-derived names and the sending domain.

# naming.ts

## Slug-derived names

Every name this package derives from a tenant slug, in one place, including
the reserved-name list and the MySQL slug-length limit: a wrong slug here is
not harmless the moment a caller picks tenant slugs, so both stay part of
this package's own validation rather than left to a caller. `validate()`
calls `validateSlugAvailability` alongside the grammar check
`brand.ts#validateSlug` already does.

## TENANT_NAME_REGISTER and RESERVED_STACK_NAMES

Both come from `registers/tenant-names.json` in the ghost-platform repository,
the single home for every taken name. The block between the BEGIN/END
GENERATED markers is written by `scripts/sync-tenant-name-register.py` and
checked in CI with `--check`; never edit it by hand. A published package cannot
read a repository file, so the copy lags the register until the next release.

`RESERVED_STACK_NAMES` is the register's `infrastructure` entries, including
`mail-spool` (the host spool's stack, rendered by this package), refused to
every slug. `blog` is not among them: it is a `tenant` entry carrying its
repository, tenant zero's own slug, and reserving it outright would make the
package refuse the one tenant it exists to describe.

## validateSlugAvailability and the claimant

With a `claimant`, a registered `tenant` name is refused to a demo, and to a
tenant unless `claimant.repo` is that name's own repository (compared without
regard to letter case; undefined refuses). This is what stops a
template-generated duplicate of tenant zero rendering. `validate()` and
`validateTenantStack()` take the repository as `options.claimantRepo`; the
caller supplies it, because this package has no identity of its own. Without a
claimant (`render()` has none) only infrastructure names and length are
checked. The register is written by hand, so a tenant name not yet in it is not
protected; that gap is tracked as a follow-up.

## Metrics volume

`metricsVolumeName` is `ghost-<slug>-metrics`, the third per-tenant named
volume beside the content and adapters ones. One volume per tenant, never a
directory shared between tenants: a tenant writes its own volume, so a shared
one would let it overwrite another tenant's metrics file. The host-side
provisioning script (`app/provision/provision_tenant_volume.py`) mirrors the
suffix. The volume holds nothing but the scanner's metrics file, so it is not
tenant data and `identity.ts` does not list it.

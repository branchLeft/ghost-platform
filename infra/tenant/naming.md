# naming.ts

## TENANT_SLUG_PATTERN

The slug charset, shared with `db/provision/naming.py`. Kept identical
deliberately: the same string becomes a MySQL account name there and a
systemd instance name here, and a slug that is valid in one place and not
the other produces a tenant that half-exists.

The trailing character is restricted to a letter or digit — stricter than
MySQL, Compose or systemd need on their own — because `mediaBucketName`
below turns this same slug into an S3-compatible bucket name, and bucket
naming rules (AWS S3's "Bucket naming rules", which Hetzner Object Storage
follows as an S3-compatible provider) require a bucket name to both start
and end with a lowercase letter or digit. Catching that here, before
`GhostTenant`'s constructor calls `super()`, is what keeps a hyphen-ending
slug from registering a partial component with the engine only to fail
later inside `mediaBucketName`.

## RESERVED_STACK_NAMES

Stack names already in use on an app host by something that is not a
tenant.

A tenant's Compose project name *is* its directory under `/opt/branchleft`,
its `/etc/branchleft/<name>.env` secrets file and its
`branchleft-compose@<name>` unit. Provisioning a tenant slugged `website`
would therefore land on top of the marketing site's stack — overwriting its
secrets file and its Compose project — and nothing in Docker, systemd or
Pulumi would object. The refusal has to be here because this component is
the only thing that sees the slug before anything is written.

The list is the `infrastructure` entries of `registers/tenant-names.json` in
the ghost-platform repository, the single home for every taken name. It is
generated into this file between the BEGIN/END GENERATED markers by
`scripts/sync-tenant-name-register.py`; CI runs that script with `--check`.
Never edit the block by hand. A published package cannot read a repository
file at run time, so this copy lags the register until the next release.

It is a floor, not the full register: it is checked for drift against a
snapshot of the shared-infra stack register in `naming.test.ts`, which
documents how to refresh it when that register changes.

`blog` is absent from this list because it is not infrastructure: it is
`GhostTenant`'s own tenant-zero slug, and reserving it would make
tenant-zero's own stack throw at construction time on its next deploy. It is
in the register as a `tenant` entry with its repository instead, and
`validateTenantNameClaim` below is what stops a second tenant taking it.

## validateTenantNameClaim

A registered `tenant` name is claimed by its own repository only. The
claimant is the repository GitHub Actions reports in `GITHUB_REPOSITORY`; it
is never derived from the slug or from anything in the descriptor, because a
duplicate of tenant zero would copy those. With the variable unset, a local
run, a registered name is refused rather than allowed: tenant applies run in
CI, so failing closed costs nothing there. An unregistered name passes.

`GhostTenant` calls it first, before the descriptor is validated or rendered.
The check duplicates `render-core`'s `validateSlugAvailability` claim rule
until a render-core release carrying it is adopted, after which this copy is
to be deleted. The register is written by hand today, not at tenant creation,
so a hand-created tenant that is not yet in it is not refused; that gap is
tracked as a follow-up.

## contentVolumeName

Volume names are given explicitly in the rendered Compose file rather than
left to Compose's `<project>_<volume>` prefixing.

The host-side provisioning step has to create these volumes, own them to
the tenant UID and refuse a UID another tenant already holds, and it runs
before any Compose project exists to derive a prefix from. A name Compose
would have synthesised is a name that step would have to reconstruct from
knowledge of Compose's prefixing rule — so it is stated once, here, and
both sides read it.

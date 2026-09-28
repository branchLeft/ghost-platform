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

This is a floor, not the full register: it is checked for drift against a
snapshot of the shared-infra stack register in `naming.test.ts`, which
documents how to refresh it when that register changes.

`blog` is deliberately absent despite being a live stack on an app host.
Unlike every name below, `blog` is not "something that is not a tenant" —
it is `GhostTenant`'s own tenant-zero slug (`ghost-tenant-blog`'s
`index.ts` constructs `new GhostTenant('blog', ...)`, and this
constructor's `validateTenantSlug` call runs on every one of its Pulumi
previews and applies). Adding it here would not stop a second tenant from
requesting the same slug — this component has no view of other tenant
repos to check that against — it would instead make tenant-zero's own
stack throw at construction time on its next deploy. That is a different
problem (slug uniqueness across tenants, which is open-ended and not
visible from here) wearing the same shape as this one.

## contentVolumeName

Volume names are given explicitly in the rendered Compose file rather than
left to Compose's `<project>_<volume>` prefixing.

The host-side provisioning step has to create these volumes, own them to
the tenant UID and refuse a UID another tenant already holds, and it runs
before any Compose project exists to derive a prefix from. A name Compose
would have synthesised is a name that step would have to reconstruct from
knowledge of Compose's prefixing rule — so it is stated once, here, and
both sides read it.

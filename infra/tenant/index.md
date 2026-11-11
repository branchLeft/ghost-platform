# index.ts

## GhostTenant

One paying Ghost tenant on a shared Hetzner app host, configured rather than
created.

**Every artefact comes from the render core.** The component validates the
descriptor with `validateTenantStack()`, calls `render()` from
`@branchleft/ghost-platform-render-core`, and exposes the seven artefacts it
returns as stack outputs. It renders nothing itself. The broker renders demos
from the same function, so the two reconcilers cannot drift apart. The render
core is consumed as a published, exact-pinned version, never a `file:` path or
a bundled copy.

**This component declares no cloud resources, and that is the design.** Every
durable thing a tenant uses already exists and is shared: the app host, the
database host, and object storage. What is genuinely per-tenant is
configuration, and the tenant's Pulumi stack is the versioned, reviewed,
passphrase-wrapped record of it. Its checkpoint is what the delete guard
protects.

Three steps outside Pulumi must have happened before the rendered stack will
start, and each fails loudly if it has not: the tenant's database and account
on `db1` (`provision_tenant_db.py`), the tenant's two named volumes on the app
host (the `provisionScript` output), and the secrets file at
`/etc/branchleft/<slug>.env` (rendered on the host from the
`secretsEnvTemplate` output, see below).

## Secrets on the host

**The tenant stack holds no secret value.** Since 8.0.0 the component takes no
`secrets` argument and exposes no secret output, so no credential reaches
stack config, stack state or a stack output. A caller that still passes
`secrets` is refused at construction, never dropped.

The render core's `secrets.env` template names the keys a tenant needs, from
the descriptor's database, media, transport and mail choices. The component
exposes it as `secretsEnvTemplate` (key names with empty values) and the
names alone as `secretKeys`, in template order. Both are plain outputs.

The host fills it. `app/provision/render_tenant_secrets.py` takes the
template and a JSON object of KEY to value on stdin and writes
`/etc/branchleft/<slug>.env`, root-owned `0600`. It refuses a missing key, an
extra key, an empty value, a control character (a newline in an
`EnvironmentFile` value adds a variable rather than breaking one) and a
malformed owner address. See `app/provision/render_tenant_secrets.md`. The
fill logic has that one home; the component no longer carries a copy.

`secrets-absent.test.ts` is the check that no secret is exposed: it plants
sentinel values in the removed argument and in stack config, then searches
every field, registered input and recorded output, and fails on any Pulumi
secret marker or output key off its allowlist. It carries leaking stand-ins
as control cases, so a silent all-clear is not possible. See
`secrets-absent.md`.

## The owner address

The owner's email address is a person's, and a tenant repository holds no
personal data, so it is not in the descriptor this component takes
(`TenantStackDescriptor`) and not in stack config either. The render core's
template names it as `GHOST_OWNER_EMAIL` for every paying tenant, so it is
required like any other secret, and it reaches the host only through
`render_tenant_secrets.py`, which refuses an address with whitespace or no
`@`. Compose never references the key, so no container receives it. A
descriptor that still carries `ownerEmail` is refused by `validateTenantStack`
before anything is registered.

On the host, it is the `GHOST_OWNER_EMAIL` line in the secrets file that
`provision-owner.mjs --secrets-file` reads
(`adapters/sso/scripts/provision-owner.md`) when the owner account is
created.

## GhostTenantIdentity

The fields whose change destroys or orphans live tenant data rather than
updating it, read by `scripts/assert-no-tenant-deletes.py` from the
component's own preview state. Rename the content volume and the tenant's
themes and settings are orphaned; change the UID and the tenant loses its own
`0700` volume; change the database name and Ghost boots against an empty
schema. Seven of the eight fields come from the render core's
`identity.json`; `maxUserConnections` is the one this component adds, because
the descriptor does not carry it. `maxUserConnections` is not in the guarded
set: a raised cap is a safe reapply, as the Overview section of
`db/provision/provision_tenant_db.md` records.

## Constructor order

The removed-argument check, the kind check, `validateTenantStack()` and `render()` all run
before `super()`, so an invalid descriptor never reaches the engine,
registered or not.

## Constructor identity object

Computed before `super()` and passed as its props rather than `{}`, then
reused for `this.identity`: a component's step in a preview is derived from
whether its registered inputs changed, so empty props can never produce a
step, and `identity_changes()` in `scripts/assert-no-tenant-deletes.py` has no
step to read a comparison from. One object rather than two copies means the
props `super()` registers and the output the guard reads cannot drift apart.

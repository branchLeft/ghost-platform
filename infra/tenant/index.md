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
`/etc/branchleft/<slug>.env` (the `secretsEnvFile` output, placed by an
operator).

## GhostTenantSecrets

The descriptor carries no secret by design, so the five secret values and
the owner address arrive beside it. Which ones a tenant needs is not decided here: the render core's
`secrets.env` template names them, from the descriptor's database, media,
transport and mail choices.

## The owner address

The owner's email address is a person's, and a tenant repository holds no
personal data, so it is not in the descriptor this component takes
(`TenantStackDescriptor`). It arrives as `secrets.ownerEmail`, which a tenant
program reads with `config.requireSecret`. The render core's template names
it as `GHOST_OWNER_EMAIL` for every paying tenant, so it is required like any
other secret, and it reaches the host only in `secretsEnvFile`, a Pulumi
secret. Compose never references the key, so no container receives it.

Its shape is checked by `validateOwnerEmailSecret` inside the secret
`Output`, at deploy time, and a refusal withholds the value. A descriptor
that still carries `ownerEmail` is refused by `validateTenantStack` before
anything is registered.

On the host, it is the address `provision-owner.mjs --email` takes
(`adapters/sso/scripts/provision-owner.md`) when the owner account is
created.

## Secret coverage

Checked before `super()`, against the template:

- a key the template names with no matching input is refused;
- an input supplied that the template does not name is refused, not dropped.
  A dropped credential is a configuration mismatch nobody sees.

## Filling the secrets file

`fillSecretsTemplate` replaces each `KEY=` line of the render core's template
with `KEY=<value>` and leaves every other line exactly as rendered, so the
file's keys, order and header are the render core's. A value carrying a
control character is refused: systemd reads an `EnvironmentFile` line by
line, so a newline in a credential adds a variable rather than breaking one.

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

The kind check, `validateTenantStack()`, `render()` and the secret-coverage check all run
before `super()`, so an invalid descriptor never reaches the engine,
registered or not.

## Constructor identity object

Computed before `super()` and passed as its props rather than `{}`, then
reused for `this.identity`: a component's step in a preview is derived from
whether its registered inputs changed, so empty props can never produce a
step, and `identity_changes()` in `scripts/assert-no-tenant-deletes.py` has no
step to read a comparison from. One object rather than two copies means the
props `super()` registers and the output the guard reads cannot drift apart.

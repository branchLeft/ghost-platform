# Changelog

All notable changes to `@branchleft/ghost-platform-render-core` are recorded here.

## 0.2.0

**A paying tenant's owner address reaches the host only through the secrets
file, never through a descriptor a tenant repository commits.**

- New `TenantStackDescriptor`: `TenantDescriptor` without `ownerEmail`. It is
  what a paying tenant's repository commits and the Pulumi component takes.
- New `validateTenantStack(descriptor, zones)`: `validate()` for that shape.
  It refuses a descriptor that still carries `ownerEmail`, without echoing
  the value, and refuses any kind but `tenant`.
- New `validateOwnerEmailSecret(value)`: the address's shape check for a
  value that arrives as a secret. A refusal names the key and withholds the
  value, because a deploy log prints it in plain text.
- **Changed output:** `SECRET_ENV_KEYS` gains `ownerEmail`
  (`GHOST_OWNER_EMAIL`), and a `tenant`-kind `secrets.env` template names it
  last. Compose never references it, so it stays in the root-only secrets
  file and never reaches a container. A demo's template is unchanged.
- `render()` and `renderSecretsTemplate()` take a `TenantStackDescriptor`. A
  full `TenantDescriptor` is still accepted, and renders identically.
- `validate()` and `TenantDescriptor` are unchanged. A demo keeps its owner
  address inline, held by the broker.
- A sentinel test checks that no artefact of any kind contains the owner
  address.

## 0.1.1

**`blog`, tenant zero's own slug, is no longer a reserved stack name, so the
live blog's descriptor validates and renders.**

- `RESERVED_STACK_NAMES` no longer contains `blog`. 0.1.0 reserved it, so
  `validate()` and `render()` refused the live blog's slug, which
  `infra/tenant/naming.md` says must stay unreserved. No other name changed:
  `website`, `edge`, `db`, `monitoring`, `nextcloud1` and `mail-spool` are
  still refused.
- The list is pinned by a test to `infra/tenant`'s own list plus `mail-spool`.

## 0.1.0

First release: the tenant descriptor, its validation and the renderers.

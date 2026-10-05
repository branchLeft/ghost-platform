# Changelog

All notable changes to `@branchleft/ghost-platform-render-core` are recorded here.

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

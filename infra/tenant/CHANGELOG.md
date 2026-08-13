# Changelog

All notable changes to `@branchleft/ghost-platform-tenant` are recorded here.

## 0.4.0

- Added an optional `bulkEmail` arg on `GhostTenant`, injecting Ghost's
  Mailgun-compatible bulk-email config (`bulkEmail__mailgun__baseUrl`,
  `bulkEmail__mailgun__domain`, `bulkEmail__mailgun__apiKey`) so a tenant can
  point Ghost at the platform's mail shim. All-or-nothing: the three envs are
  emitted together or not at all. The API key is stored in Secret Manager,
  never a plain env value.

## 0.3.0

- Added an optional `mail` arg on `GhostTenant`, injecting Ghost's SMTP
  transactional-mail config (`mail__transport`, `mail__options__*`,
  `mail__from`). Omitted entirely when `mail` isn't passed. The SMTP
  password is stored in Secret Manager, never a plain env value.

## 0.2.0

- Fixed `GhostTenant`'s container image reference: a digest was joined with
  `:` instead of `@`, which the Cloud Run API rejects outright, so no
  published version before this one could deploy a digest-pinned tenant.
- Extracted every resource name `GhostTenant` derives from `tenantName` into
  `naming.ts`, with tests asserting the media-bucket tenant-isolation
  boundary (the trailing slash on a tenant's object prefix).

## 0.1.1

- Added the `license: MIT` field and a packaged `LICENSE` file; the registry
  had rendered `0.1.0` as Proprietary since the field was missing.

## 0.1.0

- Initial publish of the `GhostTenant` Pulumi component (per-tenant service
  account, Cloud SQL database and DB user, media-bucket storage isolation,
  scale-to-zero Cloud Run service) as `@branchleft/ghost-platform-tenant` on
  GitHub Packages.

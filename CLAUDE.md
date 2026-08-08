# CLAUDE.md — branchLeft Ghost Platform

Reusable Ghost-platform pieces shared across tenants: the tenant Pulumi component (published as `@branchleft/ghost-platform-tenant`), the Ghost container image, CI tooling, and provisioning scripts. No per-tenant identity or infrastructure lives here.

Private now, engineered to flip public later: no secrets, no tenant-identifying data, ever — in code, comments, commit messages, or CI logs.

Architecture and rationale live in `ghost-platform-docs/` — read `OPEN-QUESTIONS.md` first, every session.

## Conventions

- `infra/tenant` is a published library consumed by per-tenant repos, not a deployable stack — its CI builds/publishes the package only; no deploy jobs belong there.

# CLAUDE.md — branchLeft Ghost Platform

Reusable Ghost-platform pieces shared across tenants: the tenant Pulumi component (`infra/tenant`, published to GitHub Packages as `@branchleft/ghost-platform-tenant`), the shared platform stack (`infra/platform`), the Ghost container image, and CI tooling. No per-tenant identity or infrastructure lives here.

**This repo is public.** No secrets, no tenant-identifying data, ever — in code, comments, commit messages, or CI logs. A tenant's hostname and Cloud Run service name together are that tenant's identity; both belong in that tenant's own private repo, never here.

## Conventions

- `infra/platform` is the one shared stack (Cloud SQL instance, media bucket, tenant image registry, CI identity). `infra/tenant` is a published library consumed by per-tenant repos, not a deployable stack — its CI builds and publishes the package only; no deploy jobs belong there.
- Tenant stacks are generated from `ghost-platform-tenant-template`, one private repo per tenant. Anything naming a specific tenant belongs there, not here.

## graphify

`graphify-out/` holds a knowledge graph of this repo, rebuilt and committed by CI on every push to `main`.

- Answer codebase and architecture questions with `graphify query "<question>"` first — `graphify path "<A>" "<B>"` for a relationship, `graphify explain "<concept>"` for a concept. Each returns a scoped subgraph, far smaller than the equivalent grep.
- `graphify-out/GRAPH_REPORT.md` is the broad-navigation entry point. The payload files behind it are read-blocked in `.claude/settings.json` — go through the query commands instead.
- After changing code, `graphify update .` refreshes the graph locally. AST-only, no API cost.
- `graphify-out/.graphify_root` and `.graphify_python` are never committed: they record absolute paths on the machine that built the graph, and a foreign value in either one is worse than its absence.

# CLAUDE.md — branchLeft Ghost Platform

Reusable Ghost-platform pieces shared across tenants: the tenant Pulumi component (`infra/tenant`, published to GitHub Packages as `@branchleft/ghost-platform-tenant`), the shared platform stack (`infra/platform`), the Ghost container image, and CI tooling. No per-tenant identity or infrastructure lives here.

**This repo is public.** No secrets, no tenant-identifying data, ever — in code, comments, commit messages, or CI logs. A tenant's hostname and Cloud Run service name together are that tenant's identity; both belong in that tenant's own private repo, never here.

## Conventions

- `infra/platform` is the one shared stack (Cloud SQL instance, media bucket, tenant image registry, CI identity). `infra/tenant` is a published library consumed by per-tenant repos, not a deployable stack — its CI builds and publishes the package only; no deploy jobs belong there.
- Tenant stacks are generated from `ghost-platform-tenant-template`, one private repo per tenant. Anything naming a specific tenant belongs there, not here.

## Infrastructure

`infra/platform` is the Pulumi program for the `branchleft-ghost-platform/platform` stack. CI applies it on merge to `main` (`.github/workflows/infra-platform-ci.yml`) — that merge **is** the production deploy. `infra/provisioning` is applied only by the reviewer-gated `provision-tenant.yml`, and `infra/tenant` is a published library with no stack of its own.

- **`infra/platform/Pulumi.platform.yaml` carries no `encryptionsalt`, and it is the only committed stack config in this repo.** The salt is an offline verifier for the stack passphrase, so a public tree must not hold one — and one passphrase covers all three checkpoints this repo reaches (`branchleft-ghost-platform/platform`, `branchleft-ghost-provisioning`'s per-tenant stacks, and a tenant's own stack during provisioning), so a salt published here verifies guesses against all of them. CI appends it from the `PULUMI_SALT_PLATFORM` repository secret immediately before the first `pulumi` command in the deploy job. An operator applying by hand appends it the same way from their own copy, and does not commit the result:

  ```bash
  printf '\nencryptionsalt: %s\n' "$SALT" >> infra/platform/Pulumi.platform.yaml
  ```

- **The provisioning and tenant stack configs are not affected, for different reasons.** `branchleft-ghost-provisioning`'s `Pulumi.<tenant>.yaml` is written on the runner by `provision-tenant.yml` and never leaves it. A tenant's own `Pulumi.<tenant>.yaml` *is* committed, but to that tenant's repo, under a passphrase minted fresh for that tenant — a separate problem from this one, and not this repo's tree.
- **A `secure:` config value stays committable.** With no salt beside it, nothing in the file lets an attacker derive the key or verify a passphrase guess offline. `branchLeft/standards` PUL-12 bans the salt and only the salt, for exactly that reason. This repo commits none today; the guard below still allows them, so a stack that later needs one does not have to be weakened to gain it.
- **The repository's history is a different question, and it is still open.** Exactly one commit on `main` introduced the salt, and every commit from there to the one that removed it carries it in its tree; removing a line from the tip does not remove it from history, so anyone can read it back. The passphrase is a long random string, so this is not a practical attack, but it is only fully closed once the shared passphrase is rotated and the three stacks re-wrapped under it. A green PUL-12 gate says the tip is clean; it says nothing about that rotation.
- `infra/scripts/assert-no-committed-pulumi-secrets.py` enforces the above locally (pre-commit) and in CI (`repo-tooling-ci.yml`, tree-wide). It ships with a `--self-test` that runs on every edit to it, because a matcher that has quietly stopped matching passes every file.

## graphify

`graphify-out/` holds a knowledge graph of this repo, rebuilt and committed by CI on every push to `main`.

- Answer codebase and architecture questions with `graphify query "<question>"` first — `graphify path "<A>" "<B>"` for a relationship, `graphify explain "<concept>"` for a concept. Each returns a scoped subgraph, far smaller than the equivalent grep.
- `graphify-out/GRAPH_REPORT.md` is the broad-navigation entry point. The payload files behind it are read-blocked in `.claude/settings.json` — go through the query commands instead.
- After changing code, `graphify update .` refreshes the graph locally. AST-only, no API cost.
- `graphify-out/.graphify_root` and `.graphify_python` are never committed: they record absolute paths on the machine that built the graph, and a foreign value in either one is worse than its absence.

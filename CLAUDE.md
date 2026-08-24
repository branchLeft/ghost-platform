# CLAUDE.md — branchLeft Ghost Platform

Reusable Ghost-platform pieces shared across tenants: the tenant Pulumi component (`infra/tenant`, published to GitHub Packages as `@branchleft/ghost-platform-tenant`), the shared platform stack (`infra/platform`), the Ghost container image, and CI tooling. No per-tenant identity or infrastructure lives here.

**This repo is public.** No secrets, no tenant-identifying data, ever — in code, comments, commit messages, or CI logs. A tenant's hostname and its stack name together are that tenant's identity; both belong in that tenant's own repo, never here.

**Migration in flight.** The tenant component now targets Hetzner app hosts and the platform's GCP estate is being wound down — `ghost-platform-docs/14-hetzner-migration-programme.md` is the programme, §18 the runtime posture the component renders. `infra/platform` (Cloud Run, Cloud SQL, GCS) is still applied and still serves the live tenant; it is retired by the wind-down story, not by the component rewrite.

## Conventions

- `infra/platform` is the shared GCP stack (Cloud SQL instance, media bucket, tenant image registry, CI identity), and `infra/hosts` is the shared Hetzner stack (the estate's `app1` and `db1`). `infra/tenant` is a published library consumed by per-tenant repos, not a deployable stack — its CI builds and publishes the package only; no deploy jobs belong there.
- Tenant stacks are generated from `ghost-platform-tenant-template`, one repo per tenant, named `ghost-tenant-<name>`. Onboarding and teardown, including the four host-side steps a GitHub runner cannot perform, are in `RUNBOOK-tenant-onboarding.md`. The prefix is fixed so a single org-level ruleset can cover every tenant repo, including tenants that do not exist yet. Anything naming a specific tenant belongs there, not here.
- **A tenant repo is public by default; private only where that tenant has asked for it.** Whether it is public is a disclosure about that tenant — the repo, and its name, say that they are a customer — so it is a decision about a customer relationship, not an engineering one. **Ask it and get an answer before the work starts**: before the repo is created, before a GCP resource exists, before anything is committed. **An agent never chooses it**; with no answer from the tenant on record, stop and put the question to them. `provision-tenant.yml` is built to match — its dispatch form opens on a visibility option that is not a valid answer, and input validation refuses anything but a deliberate `public` or `private`, before anything is created.

## Infrastructure

`infra/platform` is the Pulumi program for the `branchleft-ghost-platform/platform` stack. CI applies it on merge to `main` (`.github/workflows/infra-platform-ci.yml`) — that merge **is** the production deploy. `infra/provisioning` is **no longer applied by anything**: it declares the GCP deploy identity a tenant repo needed under Cloud Run, and `provision-tenant.yml` stopped creating one when tenant provisioning moved to Hetzner. Its per-tenant stacks still hold the identities the live GCP tenant is using, so the program stays until the wind-down destroys them — deleting it first would leave those resources in state with no code to `pulumi destroy` from. `infra/tenant` is a published library with no stack of its own. `infra/hosts` (`branchleft-ghost-platform-hosts/production`, state on the Hetzner backend) applies from CI on merge to `main` (`infra-hosts-ci.yml`): a plan job puts the `pulumi preview` in the job summary, then the apply waits on the `production` environment's required-reviewer rule — failing closed if that rule is absent — with `infra/scripts/assert-no-hetzner-deletes.py` refusing any plan that destroys a protected resource. Pull requests run its typecheck and unit tests only; no cloud credential touches PR code. The one hand-run operation is the stack's own bootstrap (`pulumi stack init`, which touches state only and creates no cloud resource).

- **No committed stack config in this repo carries an `encryptionsalt` — `infra/platform/Pulumi.platform.yaml` and `infra/hosts/Pulumi.production.yaml` are the two committed stack configs, and both are salt-free.** The salt is an offline verifier for the stack passphrase, so a public tree must not hold one — and one passphrase covers all three checkpoints this repo reaches (`branchleft-ghost-platform/platform`, `branchleft-ghost-provisioning`'s per-tenant stacks, and a tenant's own stack during provisioning), so a salt published here verifies guesses against all of them. CI appends it from the `PULUMI_SALT_PLATFORM` repository secret immediately before the first `pulumi` command in the deploy job. An operator applying by hand appends it the same way from their own copy, and does not commit the result:

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

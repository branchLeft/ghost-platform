# Contributing to branchLeft/ghost-platform

This repo follows the [org-wide contribution guide](https://github.com/branchLeft/.github/blob/main/CONTRIBUTING.md) — fork, branch, PR, squash-merge, one required review. This file covers what's specific to `ghost-platform`.

## Prerequisites

- Node version pinned in [.nvmrc](.nvmrc) — run `nvm use` before anything else.
- **npm**, not pnpm. The other branchLeft repos use pnpm; this one does not.
- **Docker.** The image checks are a real `docker build` and two scripts that boot the built image, so Node alone is not enough to run what CI runs.

## Setup

There are three independent npm projects here, each with its own lockfile. There is no workspace linking them — install whichever you are working on.

```bash
nvm use
npm ci                      # root: lint/format tooling only
npm ci --prefix infra/tenant
npm ci --prefix infra/platform
```

## Checks CI runs on every PR

These are exactly what [.github/workflows](.github/workflows) runs:

```bash
# build.yml
docker build -t ghost-platform:local .
./scripts/smoke-test.sh ghost-platform:local
./scripts/test-storage-guard.sh ghost-platform:local

# infra-tenant-ci.yml  (job: Tenant type check)
npm ci --prefix infra/tenant && npx --prefix infra/tenant tsc --noEmit

# infra-platform-ci.yml  (job: Platform type check)
npm ci --prefix infra/platform && npx --prefix infra/platform tsc --noEmit
python3 infra/platform/scripts/assert-no-platform-deletes.py --self-test
python3 infra/platform/scripts/assert-no-platform-deletes.py --verify-coverage infra/platform
```

**Fork PRs run all of these.** `build.yml` holds no credentials and neither type-check job requests `id-token`, so nothing in the PR path needs secrets. Only the deploy and image-push jobs authenticate, and both are gated on pushes to `main`.

## Pre-commit hooks

This repo uses [pre-commit](https://pre-commit.com) (config in [.pre-commit-config.yaml](.pre-commit-config.yaml)) to run formatting and linting on `git commit`:

```bash
pip install pre-commit   # or: brew install pre-commit
pre-commit install
```

`npm ci` at the root runs `pre-commit install` for you outside CI.

If a hook fails it usually auto-fixes the issue (Prettier, whitespace) — re-stage and commit again. Lint failures you fix yourself.

## What belongs here, and what doesn't

`infra/platform` is the one shared stack. `infra/tenant` is a reusable component published as `@branchleft/ghost-platform-tenant`; it is not a deployable stack, so no deploy job belongs in its workflow.

**Nothing in this repo may name a tenant** — not in code, comments, commit messages, or CI logs. A hostname and a Cloud Run service name together are a tenant's identity. Tenant stacks live in one repo per tenant, named `ghost-tenant-<name>` and generated from [`ghost-platform-tenant-template`](https://github.com/branchLeft/ghost-platform-tenant-template). That repo is public unless the tenant asked for it to be private — a question settled with the tenant before their onboarding starts, never decided here.

## Comment style

Comments state what the code cannot: a constraint, an invariant, a reason a naive approach fails. They do not narrate what the code does, and they do not record the development process — no ticket IDs, no names, no dated verification logs, no decision history. That belongs in the PR description.

## Publishing

Don't run `npm publish` locally. Releases are triggered by pushing a `v*.*.*` tag and handled entirely by [publish-tenant-package.yml](.github/workflows/publish-tenant-package.yml).

# refresh-lockfile.yml

## What it is for

A pin bump of a `@branchleft/*` dependency (a render-core release in
`infra/tenant`, a `@branchleft/hetzner-host` release in `infra/hosts`, a
`@branchleft/tsconfig` release anywhere) changes the `sha512` integrity and the
tarball URL recorded in that project's `pnpm-lock.yaml`. The packages are on
GitHub Packages, which answers 401 or 403 to an anonymous or App-token read, so
neither a person without a package token nor an agent can write those values.
The CI install can read them: the run's own `GITHUB_TOKEN` carries
`packages: read`.

This workflow runs the resolve step in CI and hands the lockfile back. It is a
`workflow_dispatch` with two inputs, `ref` (the branch) and `project_dir` (the
pnpm project), and nothing else.

## Why it commits nothing

`generate-lockfile.yml` already resolves a lockfile in CI, but it holds
`contents: write` and writes the commit itself through `createCommitOnBranch`.
Two consequences follow, and this workflow avoids both.

- A write token that checks out and installs a branch's code is a larger
  grant than the job needs. This job holds `contents: read` and
  `packages: read` and nothing else, so a compromise of the install step reads
  public source and public packages.
- A commit made with `GITHUB_TOKEN` starts no `push` or `pull_request` run, so
  the head it creates has no checks and `generate-lockfile.yml` ends in a
  deliberate failure to say so. Here the dispatcher downloads the artifact and
  commits it as an ordinary signed commit; that push starts the pull request's
  checks.

## Inputs reach the shell only through `env:`

`ref` and `project_dir` are never expanded inside a `run:` block. The `validate`
job takes them through `env:`, refuses a `ref` that is not a plain short branch
name (a qualified `refs/...` form, `..`, a trailing slash or `.lock`, anything
outside `A-Za-z0-9._/-`), and refuses a `project_dir` outside a fixed list. Every
later step receives the validated values as job outputs, again through `env:`.
The list appears twice in the file (the `options:` and the `case`) because
GitHub's own choice check is not a control the job should depend on; `workflow-refresh-lockfile.test.js`
keeps both equal to the pnpm projects that consume
`@branchleft/*`.

## The install runs in a copy

Every project carries a committed `.npmrc`, and pnpm lets a project-level
`.npmrc` outrank the user-level file `setup-node` writes. A branch author could
point `@branchleft:registry` at another host with
`_authToken=${NODE_AUTH_TOKEN}` and read the run's token. The resolve step
therefore runs in a directory under `$RUNNER_TEMP` holding only `package.json`,
the existing lockfile and `pnpm-workspace.yaml`, so no project `.npmrc` applies.

## Using it

1. Dispatch it for the branch and the project:
   `gh workflow run refresh-lockfile.yml --ref <branch-holding-this-file> -f ref=<branch> -f project_dir=<dir>`.
2. When it finishes, download the artifact `refreshed-pnpm-lock` and copy
   `pnpm-lock.yaml` over `<dir>/pnpm-lock.yaml` on the branch.
3. Commit it, signed, and push. The push starts the pull request's checks,
   including the frozen-lockfile install.

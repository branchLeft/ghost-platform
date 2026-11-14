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

On a pull request that changes the `package.json` of such a project, this
workflow resolves the lockfile in CI and compares it with the committed one. If
they differ it says so in the job summary, with the diff, and uploads the
regenerated file as the artifact `refreshed-pnpm-lock-<project>` (the file sits
at `<project>/pnpm-lock.yaml` inside it). Whoever owns the branch commits it as
an ordinary signed commit. If they match, it says that and uploads nothing.

## Why a pull request trigger and not a dispatch

`generate-lockfile.yml` resolves the same way but needs a person to dispatch it,
which an agent may not do, and it commits through `GITHUB_TOKEN`, so the head it
creates has no checks and the run ends in a deliberate failure. This workflow
needs no dispatch, holds `contents: read` + `packages: read` only, and commits
nothing: the branch owner's own push starts the checks on the real head.

The resolve logic is the same isolated-directory install as
`generate-lockfile.yml`, written out again here. One home for it, a composite
action both call, is a separate change to be made once this one is proven; this
file does not touch `generate-lockfile.yml`.

## Untrusted code

- `pull_request`, never `pull_request_target`. The job runs the pull request's
  own files, so it must never have the base repository's secrets. It also runs
  on a push to `main` that changes a `package.json` (standards CI-3), comparing
  with the commit before; that event only ever comes from this repository.
- A pull request from a fork is skipped by the `if:` on the first job (the
  second needs it) and receives a read-only token with no package access in any
  case. A Dependabot pull request is skipped too.
- A same-repository author already has write access and the existing CI installs
  with the same token on the same files, so this adds no reach. The one real
  exposure is a committed `.npmrc` redirecting `@branchleft:registry` with
  `_authToken=${NODE_AUTH_TOKEN}`; the install therefore runs in a copy under
  `$RUNNER_TEMP` holding only `package.json`, the lockfile and
  `pnpm-workspace.yaml`, so no project `.npmrc` applies. A pull request can edit
  this workflow itself; that is true of every pull request workflow here.
- Nothing is interpolated into a shell line. The base and head SHAs pass through
  `env:`; the list of projects is JSON produced by
  `scripts/select-lockfile-projects.py`, which reads `package.json` as data and
  skips a directory name outside a plain allow-list.

## Using it

1. Open the pull request. If the run reports a stale lockfile, download the
   artifact and unzip it at the repository root, which places
   `<project>/pnpm-lock.yaml`.
2. Commit it, signed, and push. The push starts the pull request's checks,
   including the frozen-lockfile install, and this workflow again, which now
   reports the lockfile as up to date.

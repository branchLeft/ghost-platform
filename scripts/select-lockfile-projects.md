# select-lockfile-projects.py

Called by `refresh-lockfile.yml` to turn a pull request's changed files into the
list of pnpm projects whose lockfile might no longer satisfy their
`package.json`.

## What it selects

A changed path that is a `package.json`, whose project is a pnpm project (a
`packageManager` of `pnpm@...` or a committed `pnpm-lock.yaml`) and which
depends on a `@branchleft/*` package other than through `link:`. A `link:`
dependency resolves inside the tree and needs no registry read, so a project
that only links is left alone.

## What it does not do

It does not run `pnpm`, read the registry or decide whether the lockfile is
stale: the workflow does that by resolving in an isolated directory and
comparing. It reads `package.json` as JSON data only. A directory name outside
`A-Za-z0-9._-` segments is skipped, and more than 20 projects is an error
rather than a silent cut.

## Tested

`workflow-refresh-lockfile.test.js` runs it against a fixture tree.

# generate-lockfile.yml

## Why createCommitOnBranch

`generate-lockfile.yml` used to finish with an ordinary `git commit` +
`git push origin HEAD:refs/heads/$BRANCH`, authenticated with the run's own
`GITHUB_TOKEN` via an `extraheader`. That push lands on GitHub, but GitHub
never signs it — the commit is authored as `github-actions[bot]` and stays
unverified — and this repo's `main` ruleset requires every commit on a PR
to be signed. A branch that only ever got a lockfile from this workflow
could never merge; the PR had to be replaced by one carrying the same
change as a normally signed commit instead.

`createCommitOnBranch` is GitHub's own API for writing a commit. Every
commit it makes is signed by GitHub itself, the same way a web-UI edit or a
squash-merge already is, because there is no git identity or key for a CI
job to hold in the first place. The workflow submits the already-generated
`package-lock.json` as one `fileChanges` addition, keyed to `expectedHeadOid`
so GitHub itself rejects the write if the branch has moved since checkout.
After the mutation, the job reads the new commit back
(`GET /repos/{owner}/{repo}/commits/{sha}`) and refuses to report success
unless `verification.verified == true` — proving the commit actually
verifies, not just that the API accepted the write.

This mirrors the same fix already landed for the sibling pnpm-lockfile
workflow in `ghost-platform-tenant-template` (`generate-pnpm-lockfile.yml`),
adapted for a single npm `package-lock.json` in a caller-supplied
`package_dir` rather than a fixed root `pnpm-lock.yaml`. `path` travels as
its own GraphQL variable rather than a literal in the query text, because
`package_dir` is caller input here in a way the sibling workflow's fixed
paths never were.

## Why the request is built in a file, not passed to `gh` as an argument

Linux caps a single `execve` argv or env string at `MAX_ARG_STRLEN` (128
KiB). A lockfile's base64 form can clear that well within this repo's real
sizes — `services/mail-collector` and `services/mailgun-shim` already do —
so passing the encoded content to `gh api graphql -f content=...` fails
with "Argument list too long" before `gh` ever runs, for exactly the
lockfiles this workflow most needs to handle. An env var carries the same
cap, so moving the content there is not a fix either.

Instead, `base64` writes straight to a file over stdout, `jq --rawfile`
reads that file's bytes directly rather than taking them as a `--arg`, and
the finished `{query, variables}` request goes to `gh api graphql --input
<file>` as a file `gh` reads itself — the content is never a command-line
string or an environment value at any point.

## Why fail closed instead of dispatching CI

A commit written through the GitHub API is still `GITHUB_TOKEN`-authenticated
underneath, so it still fires no `push`/`pull_request` event and no check
run attaches to it on its own — a PR carrying this branch would otherwise
show green with nothing having run at its head.

Dispatching the repo's own PR-check workflows at the new head was
considered and rejected here. This repo carries around thirty separate
CI workflows, most path-filtered to one package directory apiece, several
calling reusable workflows from other repos, and the set changes over time
as packages are added. Working out which ones apply to an arbitrary
`package_dir`, keeping that mapping correct as workflows are added or
renamed, and adding `workflow_dispatch` to each would be a repo-wide change
far outside this workflow's own concern — the opposite of the narrow, single-
file fix this workflow otherwise is.

Instead, the job writes its summary and then **fails the run** (`exit 1`)
whenever it committed: the commit itself is fine — already GitHub-signed,
already read back and checked — but a green tick here would be exactly the
"looks checked, nothing ran" state this workflow exists to remove. The
summary says plainly that the commit landed and is signed, that the
failure means only that CI hasn't run yet, and how to start it: close and
reopen the pull request carrying the branch, or push an ordinary commit to
it. Both are actions a person already takes to get CI running today; this
just tells them to, and fails until they do.

# generate-pnpm-lockfile.yml

## What it does

One dispatch converts every `package-lock.json` in the repository to a
`pnpm-lock.yaml` in the same directory and commits the swap to a feature
branch through `createCommitOnBranch` (GitHub signs the commit; the job reads
it back and fails unless `verification.verified` is true). It takes one input,
`branch`, and refuses `main`, `master` and any branch a ruleset protects. It
is a one-off conversion: it needs a `package-lock.json` to convert and fails
when there is none. Keeping a pnpm lockfile current afterwards is a different
job.

The commit, the signing read-back and the "no CI at the new head" failure work
as described under "Why createCommitOnBranch" and "Why fail closed" above.

## Why one lockfile per package, not one for the workspace

`pnpm-workspace.yaml` sets `sharedWorkspaceLockfile: false`, so the directories
stay a workspace (one store, `workspace:*` links, `pnpm --filter`) while each
keeps its own lockfile.

A single root lockfile cannot hold what this repository has locked. Run on
the 23 packages plus the root, `pnpm import` writes a lockfile per package,
and merging them leaves the same snapshot key (for example
`@sigstore/sign@4.1.1`) with a different dependency body in different
packages, because the packages locked different transitive versions. One body
has to win, and the package that loses is handed versions it never locked. In
a trial merge (with the private `@branchleft/*` packages left out, since no
credential for them was available), `infra/hetzner-host-check` ended up with two copies
of `@pulumi/pulumi` (3.258.0 as its direct dependency and 3.259.0 under
`@pulumi/hcloud`), which a Pulumi program must not have. Per-package
lockfiles keep every package's graph exactly as npm locked it. Moving to one
root lockfile later is a deliberate version change, taken package by package,
not a side effect of this conversion.

## The steps

1. `convert.py dirs` lists the directories holding a `package-lock.json`.
2. `convert.py stage` builds two trees under `$RUNNER_TEMP`: an import tree
   with each `package.json` (a `workspace:` link put back to the `file:` spec
   its lockfile recorded) and `package-lock.json`, and a final tree with the
   branch's own `package.json` files and `pnpm-workspace.yaml`. Both get an
   `.npmrc` the job writes, never the branch's own: a branch's `.npmrc` could
   point `@branchleft` at another host next to the run's token.
3. `pnpm import` runs in each import directory. pnpm reads only the root
   lockfile inside a workspace, hence the isolated trees.
4. Each imported lockfile is copied into the final tree and
   `pnpm install --lockfile-only --ignore-scripts` finalises it, re-resolving
   only what an import cannot carry: workspace links and `overrides`.
5. `convert.py compare` refuses the commit unless, for every directory, each
   direct dependency resolves to the version in that directory's own
   `package-lock.json`, and every package in the generated lockfile is a
   version that same `package-lock.json` locked.
6. The lockfiles are copied into the checkout, the `package-lock.json` files
   removed, and `convert.py changes` matches `git status --porcelain`
   whole-line against exactly that swap.

The program lives inside the workflow file on purpose: the job runs against
whatever branch was dispatched, and a program kept in the repository could be
missing or edited on that branch. `workflow-pnpm-lockfile-convert.test.js`
extracts it from the YAML and runs it over fixtures.

## What the branch must carry

- `pnpm-workspace.yaml` with `packages:` listing every directory that has a
  `package-lock.json` (except the root), `sharedWorkspaceLockfile: false`, and
  only the keys `packages`, `allowBuilds`, `overrides`.
- An `overrides:` entry for every name a `package.json` lists under npm's
  `overrides`. pnpm ignores npm's field, and a pnpm override applies to the
  whole workspace, so one package's override is written as a selector such as
  `parent@version>name` to keep it from reaching another package.
- No `pnpm` or `resolutions` field in any `package.json`.

If a refusal says pnpm resolved a version a package never locked, the cause is
usually a missing override or a dependency npm resolved differently; the
message names the directory, the package and the versions.

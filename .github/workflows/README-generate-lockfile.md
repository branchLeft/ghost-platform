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

Instead, the job reports plainly, in its own summary, that the new head has
no CI and exactly how to get it: close and reopen the pull request carrying
the branch, or push an ordinary commit to it. Both are actions a person
already takes to get CI running today; this just tells them to.

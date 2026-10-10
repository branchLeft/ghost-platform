# Release watcher

Polls Ghost's Alpine tags on Docker Hub every six hours and keeps one pull
request per major line that moves the base image in `Dockerfile` to the
newest stable tag and its digest. Fixed code only, no model in its path.

Run by `.github/workflows/release-watcher-run.yml`. Tests:
`.github/workflows/release-watcher-ci.yml` (`python3 -m unittest discover -s tests -p 'test_*.py'`).

## What it does

- Pinned line: the major number in the `FROM` line. Only tags on that line are
  considered. A newer major is printed as a notice on every run and never
  followed.
- Tags: plain `N.N.N-alpine` only. Pre-release, `-next`, variant and
  non-ASCII tags are never chosen.
- One branch per major line, `release-watcher/ghost-<major>`. A newer tag or a
  changed digest on the same line updates the open PR in place. A PR is never
  duplicated.
- A kept branch stops the run with an error and opens nothing when it is behind
  `main`, when it changes any file other than `Dockerfile`, or when its
  `Dockerfile` differs from `main` anywhere other than the `FROM` line. The owner
  deletes the branch; the next run recreates it from `main`. The watcher never
  updates or opens a PR on a stale base, but an already-open PR is not closed by
  the refusal; the owner closes it.
- A PR closed without merging is not reopened for the same digest. A newer tag
  or digest reopens it.
- A failed step fails the run and does not update the poll-age gauge, so the
  gauge's age keeps growing until the cause is fixed.
- The poll-age gauge is `ghost_release_watcher_last_success_timestamp_seconds`,
  written to `release-watcher.prom` on the `state/release-watcher` branch, beside
  `ghost_release_watcher_pr_writes_enabled`. A value of 0 means the runs succeed
  but cannot open PRs (no `RELEASE_WATCHER_TOKEN`), so a healthy age alone does
  not mean PRs are opening.
- When `main` moves to a newer major, a PR left open on the older line is not
  touched again. It stays open until the owner closes it; the watcher now
  follows the new line.

## The secret this needs

`RELEASE_WATCHER_TOKEN`, a repository secret on `branchLeft/ghost-platform`.

Minimum scope, whichever identity is chosen:

- Contents: read and write on `branchLeft/ghost-platform`, to create the
  branch and commit the `Dockerfile` change.
- Pull requests: read and write on `branchLeft/ghost-platform`, to open and
  update the PR.
- Nothing else, and no other repository.

Until the secret exists, the run warns and opens no PR. The poll still
runs and the gauge is still written.

The identity is not decided. Two options are open for the owner, and neither is
chosen by this change:

- A GitHub App installation token, installed on `branchLeft/ghost-platform`
  only, with the two permissions above. Recommended: its token expires and is
  scoped to this repository.
- The workflow's own `GITHUB_TOKEN` with PR creation enabled. PRs opened with
  it do not trigger the `pull_request` CI workflows, so their required checks
  never run and the PR cannot merge without a manual push.

## Not wired yet (named follow-ups)

- The poll-age gauge is not scraped by any monitor, so the stale-age alert
  cannot fire: [ISSUE branchLeft/workspace#2002](https://github.com/branchLeft/workspace/issues/2002).
- The new-major notice is a run annotation only. The owner digest has no input
  from this job, so the owner is not notified: [ISSUE branchLeft/workspace#2001](https://github.com/branchLeft/workspace/issues/2001).

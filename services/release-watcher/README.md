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
- A branch that differs from `main` anywhere other than the `FROM` line stops
  the run. The owner merges `main` into it, or deletes it, before the watcher
  continues.
- A PR closed without merging is not reopened for the same digest. A newer tag
  or digest reopens it.
- A failed step fails the run and does not update the poll-age gauge, so the
  gauge's age keeps growing until the cause is fixed.
- The poll-age gauge is `ghost_release_watcher_last_success_timestamp_seconds`,
  written to `release-watcher.prom` on the `state/release-watcher` branch.

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

## Not wired yet

- The poll-age gauge is not scraped by any monitor. The stale-age alert cannot
  fire until a scrape path exists.
- The new-major notice is a run annotation only. The owner digest has no input
  from this job, so the notice is not delivered to the owner.

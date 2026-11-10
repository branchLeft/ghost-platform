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
- Any merge to `main` while a watcher PR is open makes that branch behind main.
  The next run then refuses, every six hours, until the owner merges `main` into
  the branch or deletes the branch. In an active repo this means the open PR is
  not updated in place for long; it needs the owner's step each time `main`
  moves.
- A PR closed without merging is not reopened for the same digest. A newer tag
  or digest reopens it.
- A failed step fails the run and does not update the poll-age gauge, so the
  gauge's age keeps growing until the cause is fixed.
- The poll-age gauge is `ghost_release_watcher_last_success_timestamp_seconds`,
  written to `release-watcher.prom` on the `state/release-watcher` branch, beside
  `ghost_release_watcher_pr_writes_enabled`. A value of 0 means the runs succeed
  but cannot open PRs (no App token minted), so a healthy age alone does
  not mean PRs are opening.
- When `main` moves to a newer major, a PR left open on the older line is not
  touched again. It stays open until the owner closes it; the watcher now
  follows the new line.

## The identity this needs

A GitHub App, installed on `branchLeft/ghost-platform` only. Each run mints a
short-lived installation token for it (`actions/create-github-app-token`,
pinned by commit sha) and hands it to the watcher as `RELEASE_WATCHER_TOKEN`
inside the job. Nothing long-lived is stored.

The names the workflow reads, all on `branchLeft/ghost-platform`:

- Repository variable `DIGEST_APP_ID`: the App's id. While it is unset the mint
  step is skipped and the run opens no PR.
- Repository secret `DIGEST_APP_PRIVATE_KEY`: the App's private key, read by the
  mint step alone.

The token asks for the least the watcher uses, on this repository only:

- Contents: read and write, to create the branch and commit the `Dockerfile`
  change.
- Pull requests: read and write, to open and update the PR.
- Checks: read, for the merge step to read the required check results on the
  PR head.
- Nothing else. The watcher files no issue (a new major is a run notice), so no
  issues grant and no second token for another repository.

Until the App exists the run warns and opens no PR. The poll still runs and the
gauge is still written.

## The digest merge

After the watcher step, `python3 -m release_watcher.merge` merges the open
digest PR, or leaves it open and fails the job. It merges only when all of these
hold, each re-read live:

- `DIGEST_MACHINE_SLUG` is set, the minted token belongs to that App, and
  `DIGEST_MACHINE_LOGIN` (the variable the line-scope check reads) is exactly
  `<slug>[bot]`. If it were not, that check would pass the PR unexamined.
- The PR on the line's branch is authored by `<slug>[bot]` (type Bot), is not a
  draft and targets `main`. Any other author is skipped with a warning.
- Its diff is one modified `Dockerfile`, one hunk, one line replaced by one
  line, both `FROM ghost:<stable tag>@sha256:<digest>` on the pinned major, and
  the replaced line is the pin on `main`. A new major is never merged.
- A ruleset on `main` requires `Digest-only line scope`, which has succeeded on
  the head sha (reported by `github-actions`), and every other required check
  has passed. The checks are polled every 30 seconds for at most 30 minutes.

The call is one squash merge pinned to the head sha it checked, so a push in
between is refused by GitHub. There is no admin or bypass flag, and the repo's
auto-merge setting is neither read nor changed. A failed required check, a
timeout, a refusal from GitHub or a diff that is more than the `FROM` line fails
the job, leaves the PR open, and so leaves the poll-age gauge unwritten.

The merge itself relies on the App being a bypass actor on the default-branch
ruleset (it does not hold an approval), and on a second ruleset it cannot
bypass that requires `Digest-only line scope`.

## Not wired yet (named follow-ups)

- The poll-age gauge is not scraped by any monitor, so the stale-age alert
  cannot fire. The follow-up is named in the pull request that adds this
  service.
- The new-major notice is a run annotation only. The owner digest has no input
  from this job, so the owner is not notified. The follow-up is named in the
  pull request that adds this service.

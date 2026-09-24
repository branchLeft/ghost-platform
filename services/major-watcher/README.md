# major-watcher

Alerts the platform owner when a new Ghost major version, or its public
preview, is announced upstream (branchLeft/workspace#1301). Nothing else:
no PR, no merge, no deploy, no other system touched. Compare with the
sibling release watcher in branchLeft/workspace#1252, which opens a PR for
a new *minor* and only sends an owner-digest note (never a page) if it
happens to see a new major go by -- that story is unbuilt and this one
does not depend on it.

Constraint this is built to (branchLeft/workspace#1274, branchLeft/workspace#1159,
and D38/D39/D42): a scheduled watcher that pages a human is monitoring,
not an agent in operations. Nothing here runs a model, and nothing here
acts on the announcement besides paging.

## Signal

`GET https://api.github.com/repos/TryGhost/Ghost/releases` -- the newest
100 releases, newest first, is checked every run. Considered and rejected:

- **npm dist-tags.** `ghost`'s npm publishes lag TryGhost's own GitHub
  releases and carry no `prerelease` boolean or per-version timestamp
  without a second request per version.
- **The Ghost blog / changelog.** Prose meant for a human reader. Turning
  "a new major is here" into a reliable machine signal would mean parsing
  sentences, not reading a status code -- exactly the unreliability this
  story exists to avoid.

GitHub Releases give a structured, versioned, timestamped record of the
exact moment TryGhost calls a build ready to announce -- including
prereleases, which is what "public preview" means in practice: TryGhost
tags and publishes one before every major GA (`v6.0.0-alpha.1`,
`v6.0.0-alpha.2`, four `v6.0.0-rc.*`, then `v6.0.0` itself, all real tags on
that repo).

**Real trap found while checking this premise:**
`v6.0.0-rc.2` is flagged `"prerelease": false` by GitHub's own API, despite
its tag being unambiguously a release candidate. `src/semver.ts` parses the
tag string itself rather than trusting that field -- see its header comment
and `test/unit/semver.test.ts`'s dedicated test for this exact tag.

## Decision (`src/detect.ts`)

Fires at most once per major line: the first time any release (preview or
GA) carrying a major number higher than the last one notified about is
seen. The message is written around whichever release of that line
published *earliest* -- a preview if TryGhost shipped one, the GA itself
otherwise -- giving the maximum possible lead time before a major lands,
which is the whole reason for alerting on the preview rather than waiting
for GA ("get ahead of it... support it at a similar pace to competitors").
A later release of the same major line -- another preview, the eventual GA
once a preview already fired, or any minor/patch -- changes nothing.

One page of releases (100, newest-first) is plenty for any realistic poll
cadence: Ghost ships roughly weekly, so 100 releases covers well over a
year of history.

## State

`WatcherState` is one integer, `lastNotifiedMajor`. It is read and written
as a plain JSON file by `src/state.ts`, which knows nothing about git --
that keeps the decision logic unit-testable with no network and no
repository. What makes the file survive a runner restart is the workflow
around it (`.github/workflows/major-watcher-run.yml`): before running, it
fetches a dedicated branch, `state/major-watcher`, and reads the file from
there; after running, if the state changed, it commits and pushes the new
file back to that same branch. That branch carries no ruleset (checked
directly: `ghost-platform`'s only rulesets target `~DEFAULT_BRANCH` and
`refs/tags/v*`), so this push needs no PR, no review and no signed commit
-- state is data, not a change to what ships.

A missing or malformed state file is a **hard error**, never a default.
Defaulting `lastNotifiedMajor` to 0 would make the very first run against
an estate already mid-major-6 fire a page for a major announced over a
year ago -- proven by sabotage in `test/unit/state.test.ts` and
`test/unit/check.test.ts` (see the PR body for the actual red/green run).

### Bootstrapping

The workflow's setup step creates `state/major-watcher` with a seed file
if the branch does not exist yet, using the major line hardcoded in that
step's `SEED_LAST_NOTIFIED_MAJOR` env var. This value is deliberately
static in the workflow file, never derived from a live query at bootstrap
time, so the first-ever run's baseline is an auditable, reviewed number
rather than whatever the API happened to return that day. It is seeded to
`6` in this PR, the major line confirmed live at the time this was written.

## Owed

**Self-hosted ntfy is not deployed anywhere in the estate yet**: no ntfy
service, container, systemd unit, Caddy route, topic or token exists in
`shared-infra`, and `alertmanager.yml.tmpl` still carries only an email
receiver and two Healthchecks.io webhooks -- no receiver reaches a phone,
matching branchLeft/workspace#1273's still-open statement. This service is
built to ntfy's publish interface (a bare HTTP POST, `src/ntfy.ts`) and
needs no Alertmanager wiring -- it pages directly, independent of
branchLeft/workspace#1273's still-open Alertmanager page-receiver
decision.

Before the scheduled workflow can page for real:

1. Stand up a self-hosted ntfy instance somewhere in the estate (own
   story; out of scope here).
2. Create the repo secrets `NTFY_URL` (the full topic URL) and, if the
   instance requires auth to publish, `NTFY_TOKEN`, on `branchLeft/ghost-platform`.

The schedule (`major-watcher-run.yml`, every 6 hours) is live from this PR
-- no separate step to enable it once the secret exists. Until `NTFY_URL`
is set, each run is a deliberate, clean no-op (exit 0) rather than a red
run: a schedule failing every 6 hours for however long the ntfy story
takes would desensitise exactly the signal this exists to protect, the
same failure class branchLeft/workspace#1163 calls out ("the control plane
stops, nothing pages, because the thing that would page is the thing that
is down"). A red run stays reserved for something actually wrong once the
secret exists: an unreachable GitHub API, a corrupt state file, or ntfy
itself rejecting the publish (auth, network, a bad topic).

**Neither state is silent, though.** A green run and a green run mean
different things here -- "nothing new happened" and "nothing new happened,
also nobody would have been paged even if there had been" look identical
in the Actions run list otherwise. `src/cli.ts`'s `main()` writes a GitHub
Actions `::warning::` annotation and a `$GITHUB_STEP_SUMMARY` line on
every no-op-because-not-configured run, and an `::error::` annotation plus
a summary line (on top of the non-zero exit) on a hard failure -- both
checked directly against `main()`, not against a log line nobody reads
until they think to look (`test/unit/cli.test.ts`).

## What "a day" means here

`major-watcher-run.yml` runs every 6 hours (`0 */6 * * *`), well inside the
Done criterion's day-long SLA even allowing for a missed run or two.

## Accepted risk: the state branch is not access-controlled

`state/major-watcher` deliberately carries no ruleset (see "State" above)
so a dedupe-only write needs no PR, no review and no signed commit. The
consequence: anyone with ordinary repo write access -- or a compromised
token that has it -- can push `{"lastNotifiedMajor": 999}` to that branch
directly, no review step in the way, and silently, permanently suppress
every future real major announcement from then on. This is the specific
failure mode of the tradeoff, named rather than left implicit.

**Cheap mitigation, an owner step (a repo settings change, not something
this PR does):** add a ruleset scoped to `refs/heads/state/major-watcher`
that restricts pushes to the workflow's own identity (a "restrict who can
push" rule naming the Actions bypass actor, mirroring the shape of this
repo's existing `Protect default branch` and `release tags` rulesets). A
related, separate owner option worth deciding alongside it: **`Major
watcher type check and test` (`major-watcher-ci.yml`) is not currently
one of this repo's required status checks** (`docker build`, `Tenant type
check`, `Format and lint`, `docs-lint / docs-lint`, `standards / Standards
gates` are), so a future PR touching `services/major-watcher/` can merge
without its own 43 tests having run green.

## Known limitations

- **GitHub disables a scheduled workflow after 60 days with no repository
  activity in it** (the same trap branchLeft/workspace#1252's own story
  names for its watcher). `ghost-platform` sees frequent commits, so this
  is immaterial today, but nothing here defends against or alerts on it --
  a silently disabled schedule and "nothing new to report" look the same
  from outside the Actions UI.
- **The signal is a published GitHub Release object, never a bare git
  tag.** If TryGhost ever tagged a preview well before publishing the
  corresponding Release, this watcher would not see it until the Release
  object appears. Checked against real data for the entire 6.0.0 sequence
  (alpha through GA): tag and `published_at` land together every time, so
  this is a hedge against a practice change, not a defect against current
  practice.

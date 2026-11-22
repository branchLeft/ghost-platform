# Workflow cron minute test

GitHub starts scheduled workflows on a best-effort basis and, under load, drops runs queued for the top of the hour. `major-watcher-run.yml` was set to `0 */6 * * *` and has never run once in the weeks since it merged, while `release-watcher-run.yml` (`17 */6 * * *`) fired more than a hundred times over the same repo, token and ruleset. Nothing else distinguished the two, so the schedule moved off minute 0.

`test_workflow_cron_minute.py` reads every `.github/workflows/*.yml` as text (the repo's Python jobs install no YAML parser) and fails for any `- cron:` entry whose minute field fires at minute 0: a plain `0`, `*`, a step such as `*/15`, a range from 0, or a list containing 0. A minute field it cannot read fails rather than being skipped.

The rule for a new schedule: pick an off-the-hour minute, one not used by the other workflows.

It runs in `repo-tooling-ci.yml`, which has no paths filter.

# Workflow push path filter test

A workflow with `pull_request.paths` runs on a pull request only when its diff touches an input of the job. Its `push` to main used to be unfiltered, so every merge re-ran the job on a diff it never reads: a merge that touched only `portal/` started about 30 jobs. Push events feed no required check, so the filter is safe there.

`test_workflow_push_paths.py` reads every `.github/workflows/*.yml` as text (the repo's Python jobs install no YAML parser) and fails for a workflow that has `pull_request.paths` and a `push` on main with neither `paths` nor `paths-ignore`. A tag-only push is not a push to main and is skipped. A push or pull_request trigger written inline is refused rather than skipped.

## Exceptions

`EXCEPTIONS` in the test lists the workflows that keep an unfiltered push, each with the reason. Today that is `infra-provisioning-scripts-ci.yml`, whose push is the backstop for the CODEOWNERS ownership test. An entry that is no longer a violation fails the test, so the list cannot rot.

A workflow with no `pull_request.paths` at all (the required checks among them) is out of scope: a workflow-level filter on a required check never reports and blocks the merge. Gate those with a step skip or a `changes` job instead.

It runs in `repo-tooling-ci.yml`, which has no paths filter.

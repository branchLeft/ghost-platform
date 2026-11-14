# Workflow permissions test

A job with no `permissions` key, in a workflow with none either, gets the repository's default token grant. Here that default is write to contents, packages and actions, so a pull request job that runs the PR's own code (an image test, a build script) would run it under a write token. `build.yml` did exactly that until it declared `contents: read`.

`test_workflow_permissions.py` reads every `.github/workflows/*.yml` as text (the repo's Python jobs install no YAML parser) and fails for any job that has no grant of its own and sits in a workflow with no workflow-level `permissions`. Either form is accepted, `permissions: {}` included. A workflow with no readable `jobs:` mapping fails rather than being skipped.

The rule for a new workflow: `permissions: contents: read` at the top, and any job that needs more gets it at job level with the reason beside it.

It runs in `repo-tooling-ci.yml`, which has no paths filter.

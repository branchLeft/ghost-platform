# Workflow path filters cover what the workflow reads

`workflow-paths-cover-reads.test.js` fails when a workflow that filters on
`paths:` reads a file its filter does not name.

## Why

A pull request starts a path-filtered workflow only when its diff touches a
path in the filter. A file the workflow reads but the filter omits is a silent
skip: the change merges, the check never ran, and nothing is red. The filters
are lists in YAML, which cannot share a list, so the check reads the workflows,
Dockerfiles and sources instead of copying a list.

It runs in `pnpm test`, which the `Format and lint` job runs on every pull
request, so it runs even when the workflows it checks do not.

## What it checks

For each workflow with `paths:` on `pull_request`, `pull_request_target` or
`push`, each of these reads must match that event's filter (GitHub glob rules:
`*` stays in a segment, `**` crosses `/`, `!` negates, the last match wins):

1. Every `COPY`/`ADD` source of each `docker build` in the workflow, resolved
   against the build context, plus the Dockerfile itself. `--from=` sources are
   skipped.
2. Every tracked file named in a step or elsewhere in the workflow (outside the
   `on:` block and comments), shell words resolved against the step's working
   directory.
3. The values of `node-version-file`, `python-version-file` and
   `cache-dependency-path`: a changed version file or lockfile changes what the
   job installs.
4. Upward-relative paths (`join(here, '..', '..', 'x')`, `new URL('../../x',
...)`, `"../x"`) in the sources of a directory where the workflow runs a test
   step. The base is a variable the scan cannot see, so the nearest ancestor of
   the reader that makes the path a tracked file is used.

A `paths-ignore` filter is reported as unsupported.

The function is `findUncoveredReads({ workflows, tracked, readFile })` and
returns `[{ workflow, event, path, why }]`. The test requires `[]`.

## Tables in the test file

- `DECLARED_READS`: reads a static scan cannot see (a path held in a variable
  or built at run time). Each entry names a workflow and a tracked file. An
  entry that names an unknown workflow or an untracked file fails, and so does
  one the scan now finds by itself.
- `EXEMPT`: real reads that the workflow never runs. Each entry has a reader
  path prefix and a reason. An entry that no longer hides a finding fails, so
  it cannot become a blanket ignore.

## Sabotage cases

Three tests run `findUncoveredReads` on an in-memory copy of a real workflow
with one filter line removed and assert the finding is named:

- `adapters/sso/src/**` removed from `drain-sidecar-image.yml`.
- `Dockerfile` removed from `sso-adapter-ci.yml`.
- `infra/tenant/runtime.ts` removed from `storage-gateway-ci.yml`.

A fourth removes one entry from a `push` filter only, to show `push` is held
to the same standard. Each removal fails if there was nothing to remove.

## Limits

- Reads made by a bash script a step calls (`$REPO_ROOT/...`) and paths built
  at run time are not seen. Add them to `DECLARED_READS`.
- Python `Path(__file__).parents[n]` and `.parent` chains are not seen; string
  literals joined with `..` are.
- `.dockerignore` files are not read.
- CodeQL is out of scope: its filters are language scope, not reads.
- The five required checks are not path-filtered and are not touched.

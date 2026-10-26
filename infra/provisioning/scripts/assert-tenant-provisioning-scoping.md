# assert-tenant-provisioning-scoping.py

## Module overview

`secrets.X` in a workflow step resolves an environment secret first and
silently falls back to a repository secret of the same name. That makes two
checks necessary, not one: a required secret can be present at the
environment level and *still* be readable by any workflow run in the
repository, including one added on a branch, if a same-named copy also sits
at the repository level.

  - MISSING: a required secret is absent from the environment's own secret
    list.
  - SHADOWED: a required secret's name also appears in the repository-level
    list.

This script holds only the set logic and takes no network access itself —
the two secret-name lists are the caller's job to fetch (`gh api ... | jq`
in the workflow), which is what keeps this half testable offline. `--self-test`
proves the logic against a case the pre-rename secret names could not
construct: `HETZNER_S3_ACCESS_KEY_ID` / `HETZNER_S3_SECRET_ACCESS_KEY`
genuinely need to exist at the repository level for `infra-hosts-ci.yml`, so
a required set that named them would always fail SHADOWED and a required
set that didn't would never test the check at all.

A failure message's remediation commands (`gh secret set ... --repo`) carry
the real owner/repo, read from $GITHUB_REPOSITORY — which the Actions runner
always sets — or an explicit --repo, so an operator can copy one straight
out of a failed run's log rather than reconstructing it by hand during a
failed provisioning run.

## `--verify-coverage`

`REQUIRED_SECRETS` is a hand-kept copy of the names `provision-tenant.yml`
reads. `--verify-coverage WORKFLOW` checks the two agree, in both directions:

  - a required name the workflow never reads is a finding (the guard would
    check a name nothing uses);
  - a `secrets.X` the workflow reads that `REQUIRED_SECRETS` does not cover is
    a finding (the guard would not check a name the workflow relies on).

The workflow side is every `${{ secrets.X }}` on a non-comment line, scanned
across the whole file. The provision job binds
`TENANT_PROVISIONING_APP_PRIVATE_KEY` in a step-level `env:`, not the job-level
one, so a job-level-only scan would report a required name as unused.

Exit 0 prints one line; exit 1 prints one `::error::` line per finding. The
mode reads a file and takes no network access. It is not wired into any
workflow here: adding that step is a workflow edit and is a separate change.

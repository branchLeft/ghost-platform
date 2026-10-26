# test_runbook_names_match_workflow.py

## Module overview

RUNBOOK-tenant-onboarding.md tells the operator which secrets and variables to
set before the first run of provision-tenant.yml. The workflow reads the
provisioning GitHub App key and ID at its mint step. A runbook that names a
retired token instead leaves the first run without the key, and the mint step
fails.

This test reads the mint step's `vars.` and `secrets.` references through the
helpers in test_provision_tenant_flow_gate.py, and checks that the runbook sets
each one with the same kind (`gh secret set` or `gh variable set`). Environment
secrets must carry `--env tenant-provisioning`, the environment the job declares.
It also checks that the runbook deletes the retired token and never sets it.

Runs under the same `discover` invocation as its neighbours, with no workflow
change.

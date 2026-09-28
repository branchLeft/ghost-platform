# test_assert_tenant_provisioning_token_scopes.py

## Module overview

This is the preflight `provision-tenant.yml` runs before it creates
anything: a token missing `workflow` or `repo` fails the run on whichever
later step needs it, after a repository, a stack and a published secret
already exist. These tests exercise the header-extraction and set logic
directly, including the superstring cases (`workflow_dispatch`,
`repo:status`) that a substring-matching check would wrongly accept in
place of the scope it actually requires, and the header-absent case that
must refuse rather than abort.

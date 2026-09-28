# test_provision_tenant_repo_precheck.py

## Module overview

That guard is load-bearing: it is what stops an existing tenant's hand-set
stack passphrase being minted over, which would rotate a live stack's
wrapping key without re-wrapping its checkpoint.

It was `gh repo view "$TENANT_REPO"`, which follows a rename redirect.
GitHub keeps a renamed repository's former name pointing at it until
something claims that name, so a tenant whose repository was ever renamed
could not be re-provisioned under its original name — the check reported a
repository that does not exist. This blocked a real provisioning run before
the fix landed.

**These tests execute the lookup, not just the branching.** An earlier
version injected `existing_repo` directly and asserted that an empty value
proceeds silently. That passed while the code did the opposite: on a 404
`gh api` skips the `--jq` filter and copies the raw JSON error body to
STDOUT (only "gh: Not Found" goes to stderr), so a `|| true` capture set the
variable to that body and every ordinary new-tenant run took the redirect
branch. The fixture asserted a value production never produced, which is the
shape of a test that cannot fail. `gh` is stubbed on PATH here so the real
capture runs, and the stub records that it was called.

The check is inline shell in YAML with no module to import, so this follows
`test_provision_tenant_flow_gate.py`: extract the literal block and execute
it under `bash -e`, which is what a `run:` with no `shell:` gets on a Linux
runner. A textual assertion would be satisfied by a comparison that reads
correctly and behaves differently.

`fail` is a function defined earlier in the same step; the harness stubs it,
so what is under test is the lookup and the branching, not that helper.

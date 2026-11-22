# assert-no-shared-state-secret-writes.py

## Module overview

Check 3 of the per-tenant state design: nothing re-adds the shared state key. It
fails when any file it is given names `HETZNER_S3_ACCESS_KEY_ID`,
`HETZNER_S3_SECRET_ACCESS_KEY` or `TENANT_STATE_S3_*` outside a comment. A line
that writes a secret (a `gh secret set` command, or a PUT to a `/secrets/` path)
is reported as a write, any other line as a mention, and a write whose secret
name is not a literal is refused because the check cannot see what it writes.
Names match in any case, because GitHub treats secret names as case-insensitive
(`secrets.hetzner_s3_access_key_id` is the same secret); a finding reports the
upper-case name. `TheSpellingsGitHubTreatsAsTheSameSecret` in the tests has one
case per spelling.

`infra-provisioning-scripts-ci.yml` runs it on `provision-tenant.yml`. The
control is `fixtures/seeded-shared-state-write.yml`, a workflow that writes the
shared pair into a tenant repository: `--self-test` and the unit tests require it
to be reported (red), and the real workflow to pass (green).
Tests: `test_assert_no_shared_state_secret_writes.py`.

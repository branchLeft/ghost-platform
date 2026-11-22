# receive-minted-state-credential.py

## Module overview

The step of `provision-tenant.yml` that takes the new tenant's own state
credential, minted at the storage gateway's state instance for that tenant
alone. The pair arrives in the `MINTED_STATE_ACCESS_KEY_ID` and
`MINTED_STATE_SECRET_ACCESS_KEY` environment secrets of `tenant-provisioning`.

It masks both values first, refuses an absent, blank, half-delivered or
malformed pair, and hands the pair on as `STATE_GATEWAY_ACCESS_KEY_ID` and
`STATE_GATEWAY_SECRET_ACCESS_KEY` through `$GITHUB_ENV`. It fails closed: it
reads no `AWS_*` variable and no shared state credential, so a pair that has not
been delivered stops the run before any repository exists, and never becomes a
quiet use of a key that reaches other tenants' state.

**The gap.** The provisioning controller's `mint-state-credential` plan step
names the mint, but a step's result is not returned by the controller today, and
nothing writes the two environment secrets. Until that delivery is built this
step always stops the run. Tests: `test_tenant_state_credential_steps.py`.

# naming.test.ts

## Shared-infra register snapshot

A snapshot of branchLeft/shared-infra's `hetzner/provision/` stack
register: `CONTRACT_COVERS` (`EXPECTED_SERVICES`'s keys: stacks whose
Compose file that repository commits) union `CONTRACT_DOES_NOT_REACH`
(stacks a Compose file elsewhere starts, each naming its owning
repository) in `hetzner/provision/test_compose_unit_contract.py`,
confirmed against `hetzner/provision/sites.ts`.

`blog` is EXCLUDED here even though shared-infra's register names it —
see `naming.md#reserved_stack_names` for why it is a `tenant` entry in
`registers/tenant-names.json`, not an infrastructure one. This snapshot is
therefore "the register minus that one documented exception", not the
register verbatim. `RESERVED_STACK_NAMES` also holds `mail-spool`, which
shared-infra does not run as a stack, so the test asserts the snapshot is a
subset of the list and the list is the snapshot plus `mail-spool`.

To refresh: re-read `CONTRACT_COVERS`/`CONTRACT_DOES_NOT_REACH` from
shared-infra's `main` (`git -C <shared-infra clone> show
origin/main:hetzner/provision/test_compose_unit_contract.py`), diff
against the array below, and update both this snapshot and
`registers/tenant-names.json` (then run
`scripts/sync-tenant-name-register.py`) together — a diff between them, not
a silent edit to one side, is what should ever change this test's outcome.

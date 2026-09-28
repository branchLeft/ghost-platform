# naming.test.ts

## Shared-infra register snapshot

A snapshot of branchLeft/shared-infra's `hetzner/provision/` stack
register: `CONTRACT_COVERS` (`EXPECTED_SERVICES`'s keys: stacks whose
Compose file that repository commits) union `CONTRACT_DOES_NOT_REACH`
(stacks a Compose file elsewhere starts, each naming its owning
repository) in `hetzner/provision/test_compose_unit_contract.py`,
confirmed against `hetzner/provision/sites.ts`.

`blog` is EXCLUDED here even though shared-infra's register names it —
see the long comment on `RESERVED_STACK_NAMES` above for why it cannot
be added to that constant. This snapshot is therefore "the register
minus that one documented exception", not the register verbatim.

To refresh: re-read `CONTRACT_COVERS`/`CONTRACT_DOES_NOT_REACH` from
shared-infra's `main` (`git -C <shared-infra clone> show
origin/main:hetzner/provision/test_compose_unit_contract.py`), diff
against the array below, and update both this snapshot and
`RESERVED_STACK_NAMES` together — a diff between them, not a silent
edit to one side, is what should ever change this test's outcome.

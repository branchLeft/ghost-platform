# check_private_tenant_plan.py

The provisioning gate for a private tenant repository. It is the only code that
reads `registers/private-tenant-plan.json`. The meaning of each attestation, and
what the owner-only guarantee depends on, is in `registers/private-tenant-plan.md`.

## Interface

```
python3 "$GITHUB_WORKSPACE/infra/provisioning/scripts/check_private_tenant_plan.py" [--register PATH]
```

The default register is `$GITHUB_WORKSPACE/registers/private-tenant-plan.json`,
or the repository root above this script when `GITHUB_WORKSPACE` is unset. There
is no environment switch that skips the gate.

| Exit | Meaning |
|---|---|
| 0 | `paid_plan_confirmed` and `dedicated_runner_confirmed` are the literal JSON `true`, and `dedicated_runner_label` starts with `private-ci-hetzner`. |
| 1 | Refused. One `::error::` line per missing attestation, then a plain trailer saying both are the owner's spend and that a personal Mac never qualifies. |
| 2 | The register is missing, unreadable, not valid JSON, has a duplicate key, or has the wrong version or shape. Fails closed, with its own `::error::` line. |

Only the literal JSON `true` passes. The string `"true"`, `1`, `null` and a
missing key do not. A non-boolean value, a missing or unknown field, or a
non-string label makes the register unusable and exits 2.

## Caller

The provisioning workflow calls the gate in two places, and each call stops the
run on a non-zero exit:

- `Validate inputs`, before any credential is written or any repository is created.
- `Generate the tenant repo from the template`, which re-derives the visibility
  flag rather than trusting validation.

## Tests

`test_check_private_tenant_plan.py` holds the truth table. It runs this script
against fixture registers and against the committed register. The committed
register must exit 0 or 1, never 2, so the owner's flip never turns the test red.

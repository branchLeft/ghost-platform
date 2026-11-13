# check_provisioning_gate_left_open.py

Detects the tenant-provisioning gate left open. `provision-tenant.yml` refuses
unless the `TENANT_PROVISIONING_FLOW_HETZNERISED` repository variable is exactly
`true`. The runbook opens it just before a run and closes it afterwards, and
nothing checked that the close happened. It once stayed open for eight days, and
a check run meanwhile reported it closed.

## Caller

`.github/workflows/provisioning-gate-watch.yml` runs it every hour. A red run is
the alert. The workflow reads the variable through the `vars` context, because
the workflow token cannot list repository variables, and lists the recent
`provision-tenant.yml` runs with `actions: read`.

## Interface

```
FLOW_READY=<value> python3 check_provisioning_gate_left_open.py [--runs-file PATH] [--grace-minutes N] [--now ISO]
```

| Exit | Meaning |
|---|---|
| 0 | Closed, or open while a run is queued or in progress, or open within the grace period (120 minutes) of the latest run's last change. |
| 1 | Open with no active run and no recent one. One `::error::` line, naming the command that closes it. |
| 2 | Open, and the runs file is missing, not JSON, or has no `workflow_runs` list. Fails closed. |

Only the exact string `true` is open, the comparison the gate makes. Unset,
empty, `false` and `TRUE` are closed. Closed is a pass and needs no runs file:
an absent variable is the healthy state, not an error.

## What it cannot see

The variable's `updated_at` is not exposed to a workflow, so the age of an open
gate is judged from the provisioning runs, not from when it was set. An operator
who opens the gate and waits more than the grace period before dispatching will
see one red run. That is the runbook's "immediately before" rule showing.

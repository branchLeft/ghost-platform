# cutover_coordinator.py

## Overview

The ordered sequence of the blog's estate cutover, as a pure function. It calls
nothing live: every touch of the world (the table lock, the replica, Ghost, the
edge, the drain flag) is an effect the caller injects. It decides the order,
what each step must see before the next may run, and what a stop leaves behind.
The caller that wires real effects, and the observed rehearsal that runs it,
are separate work. The media copy and adapter re-point are a separate tool; the
coordinator only refuses to go on until that tool's result is confirmed.

`run_cutover(effects, limits)` runs the sequence once and returns a `Report`.
It never raises. `STEPS` is the one list of step names, in run order; a clean
run records exactly that list.

## Steps

| Step | Kind | A stop here |
|---|---|---|
| `limits` | check | REFUSED |
| `export_done` | precondition | REFUSED |
| `media_copy_verified` | precondition | REFUSED |
| `edge_repoint_approved` | precondition | REFUSED |
| `gate_control_case` | precondition | REFUSED |
| `freeze` | action | REFUSED |
| `read_coordinates` | read | ABANDONED |
| `gate` | decision | ABANDONED |
| `promote` | action | ABANDONED |
| `tables_match` | check | ABANDONED |
| `start_new_ghost` | action | ABANDONED |
| `new_ghost_ready` | check | ABANDONED |
| `measure_freeze` | check | ABANDONED |
| `repoint_edge` | action | HALTED |
| `set_drain_flag` | action | HALTED |
| `drain_flag_confirmed` | check | HALTED |
| `stop_old_ghost` | action | HALTED |
| `old_ghost_stopped` | check | HALTED |
| `release_freeze` | action | HALTED |

- **Preconditions** run before anything is touched. `export_done` is a verified
  restorable export of the blog. `media_copy_verified` is the media copy
  confirmed complete, so the new location is never pointed at half a copy.
  `edge_repoint_approved` is the queued edge apply approved by its owner.
  `gate_control_case` is the promotion gate shown refusing a disconnected
  replica in the same run, before the freeze.
- **`freeze`** takes the blog's write freeze. The effect must release anything
  it took if it fails, because a failed freeze is treated as holding nothing.
- **`gate`** is `promotion_gate.wait_for_promotion` on the frozen coordinates,
  with the injected clock and sleep. Only PROMOTE passes. It reads positions
  and thread states, never lag.
- **`promote`** then **`tables_match`**: promotion, then every blog table's
  count and checksum against frozen `db1`. The check is the outcome, not the
  mechanism.
- **`measure_freeze`** compares the time since the freeze with
  `Limits.max_freeze_seconds` before the re-point. Over the threshold abandons;
  exactly at it proceeds. The window to the re-point, and the total lock time,
  are in the report.
- **`set_drain_flag`**, **`drain_flag_confirmed`**: the old colour's drain flag
  is set and then observed set. The old Ghost is never stopped on an
  unconfirmed flag.
- **`stop_old_ghost`**, **`old_ghost_stopped`**: the old Ghost stops and is
  observed stopped. `release_freeze` is never reached otherwise, so a write
  waiting on the old Ghost fails when it stops and never lands on `db1`.

## Outcomes

| Outcome | Meaning | State left behind |
|---|---|---|
| COMPLETED | Every step passed | New estate serving, old Ghost stopped, freeze released |
| REFUSED | Stopped before the freeze | Nothing touched |
| ABANDONED | Stopped after the freeze, before the re-point | New Ghost stopped if it had started, freeze released, old estate serving, `db1` unwritten since the freeze. If `promote` ran, the replica is no longer a replica: discard and re-seed it before a retry |
| HALTED | Stopped after the re-point began, or a rollback step failed | After the re-point the freeze is deliberately held, because releasing it could break the stop-then-release order. A failed rollback is shown by `freeze_released` and the rollback steps |

A failed `repoint_edge` halts rather than rolls back: the effect may have taken
hold at the edge before it raised, so the coordinator cannot know which estate
is serving. A person decides.

## Effects contract

A probe returns exactly `True` for a confirmed state. `False`, any other
value, and any exception are all a stop. Every action is allowed to raise, and
a raise is a failed step. The status reader may raise anything: the coordinator
turns it into the gate's own unreadable-status refusal so the wait ends while
the freeze is held.

## Limits

`Limits` carries the gate timeout, the gate poll interval and the freeze
threshold. Each must be finite, above 0 and at most `MAX_FREEZE_LIMIT_SECONDS`
(the gate's own bound, 600). Anything else refuses before any effect runs, since
a bound that never arrives would hold the freeze open.

## Proof

`test_cutover_coordinator.py` covers the clean order, a refusal at each
precondition (false, unreadable, truthy-but-not-True), every gate refusal, each
abandon with its rollback order, each halt with the freeze held, and the
measured windows. A control is proven by sabotage: bypass it, see the tests go
red, restore, see them green.

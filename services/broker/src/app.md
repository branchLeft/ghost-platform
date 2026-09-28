# app.ts

## attemptColourSwap

Deploys a new descriptor into a slot already `running` one colour, into the
*other* colour, live, with the first colour still serving throughout. Called
only once the caller has confirmed `state.phase === 'running'` and
`state.colour` is set; holds the same per-slot lock `handleReconcile` already
claimed, and both reads and writes that lock's response itself so its caller
can simply `return` whatever this resolves to.

**Never calls `deps.wrapper.reset()`.** That is the one thing this function
must not do that a fresh deploy's own retry path does on failure: `reset`
stops and wipes *both* colours, and `state.colour` — the one already running
— is still genuinely serving readers for the entire duration of a swap
attempt. Draining is not stopping: this protects the old colour just as much
during a failed promotion as during a deliberate rollback, so a swap that
cannot complete leaves the slot exactly as it found it, never as an outage.

`swapTarget` is recorded before any other side effect, mirroring the
fresh-deploy path's own `preparing` write: a crash partway through this
function is otherwise invisible to `recoverCrashedSlots` — the persisted
phase would stay `running`/`liveColour` for the swap's whole duration, so a
retried `/reconcile` after such a crash would believe `liveColour` is still
live and could drain the colour the crash actually left serving.
`swapTarget` plus the new descriptor's own hash/hashId are what let
`recoverSwapInFlight` (`stateStore.ts`) tell "a swap into `target` was in
flight" apart from "this slot is quietly running", and adopt the right
colour with the right hash if it finds `target` already safely live.

## attemptColourSwap traffic move

The colours alternate, so the order in the edge's static upstream list can
never encode "prefer the newer one" — what makes the swap work in both
directions is that a new colour always boots drained, combined with Caddy's
`lb_policy first` preferring the first-listed, healthy upstream:

- Deploying into the first-listed colour (`a`): clearing its flag is already
  the one flag change that moves everything — it is healthy and first, so
  nothing further runs here.
- Deploying into the second-listed colour (`b`): clearing its flag moved
  nothing, because `a` is still healthy and still preferred. Only draining
  `a` moves traffic — which is exactly why the refusal check guards this
  branch and no other.

## attemptStopOldColour

Stops the colour a completed swap left running, drained, for the whole bake
window. Called only once the caller has confirmed `state.phase === 'running'`,
`state.colour` is set and `state.trafficBaseline` is set — the last of those
is what distinguishes "this tenancy arrived by a swap, so there is an old
colour to stop" from a fresh deploy's own `running`, which has none. Holds
the same per-slot lock `handleStop`'s caller already claimed.

Three independent checks guard the one irreversible side effect, each
refusing rather than guessing, in the order that costs least first:

1. The new colour must have *served real traffic*, not merely reported
   healthy. `deps.realTraffic` is the one signal in the estate that actually
   observes an admitted reader request (`services/demo-gate`'s counter);
   refused until a fresh reading exceeds the baseline `attemptColourSwap`
   recorded.
2. No email or batch may be `submitting` — stopping mid-send is what turns
   Ghost's own anti-duplicate rule into a reader getting a partial
   newsletter.
3. Immediately before the one irreversible side effect, the survivor must
   still be undrained and healthy right now. This mirrors
   `attemptColourSwap`'s own second, independent readiness check: no step
   may ever leave a tenant with no colour serving, and neither check above
   says anything about the survivor's own current health.

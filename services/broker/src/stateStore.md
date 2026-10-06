# stateStore.ts

## Phase

The slot's state machine. `preparing` is the slot claimed but not yet
running — written the instant `/reconcile` takes the per-slot lock
(`slotLock.ts`) and before any side effect, so a concurrent `/reset` or a
second `/reconcile` reads an occupied slot rather than a free one for the
whole duration of the attempt, not only after it completes.

`swapping` is `attemptColourSwap`'s own equivalent (`app.ts`): a colour
swap has its own multi-step side effects, and a crash partway through one
is exactly as invisible to a stale `running` phase as a crashed fresh
deploy would be to a missing `preparing` — see `recoverSwapInFlight` for
what a crash there needs, which is more than just "mark it error" (unlike
`preparing`/`resetting`, something is genuinely still serving throughout a
swap, and guessing wrong about which colour that is would fail the wrong
one closed).

`stopping` is `attemptStopOldColour`'s own equivalent (`app.ts`): recorded
before calling the wrapper's `stop` on the colour a completed swap left
running-but-drained, so a crash between that call and this phase's own
final write is recoverable rather than silently leaving the slot's
persisted state saying "running, colour X" while an operator has no way to
tell whether the other colour was actually stopped. Unlike `swapping`,
nothing here is ambiguous about *which* colour to act on — `state.colour`
already names the one survivor, so the other one is
`otherColour(state.colour)` by construction, not something recovery has to
re-derive from health signals the way `recoverSwapInFlight` must for
`swapping`.

## trafficBaseline

Set only on a `running` state reached by a completed swap (never by a
fresh deploy into a `free` slot, which has no "old colour" to stop): the
real-traffic counter's own reading for this slot, taken the instant the
swap's traffic-moving step finished. `attemptStopOldColour` refuses until a
fresh reading exceeds this one — the falsification clause's "served real
traffic", not "reported healthy". Colour-blind like the counter itself:
valid precisely because only `colour` (the survivor) can receive traffic
from the moment this was taken (see `realTraffic.ts`'s doc comment).

## resetRefusal

The evidence leaves by `detaching` before the slot resets, so `/reset`
refuses a slot that is `detaching`, or whose `evidence` marker is anything
but absent or `detached` (so `frozen`, and any unrecognised value, fail
closed; `frozen` is a freeze not yet confirmed as sealed, hashed and moved to the held area)
whatever its phase. That covers a crashed detach left in `error`. The
refusal runs before any write, so a refused slot is untouched. Only a
confirmed detach (`evidence: 'detached'`, or no marker) releases it.

`/reconcile` asks the same question of a `free` slot, because its
fresh-deploy failure path resets the slot. Boot recovery never moves a
`detaching` slot, and every `error` state it writes comes from
`errorStateOf`, which carries the marker forward so a fail-closed recovery
cannot release held evidence.

`writeSlotState` carries any unconfirmed marker already on disk into a write
that does not name `evidence`, so no transition (a reconcile colour swap, a
stop, a recovery) can drop it. Only a write that names the marker changes it.

## assertHashRotated

The one check downstream of the broker that nothing else can make:
`render-core/src/lease.ts`'s comment says rotation "is broker discipline,
not a checkable invariant" — checkable, in fact, exactly here, against what
the previous tenancy left behind, and refusing the recycle is strictly
safer than writing a hash the previous visitor already knows.

**Design decision, reviewed against the contract's own wording: this
compares only against `lastHashId`, the immediately previous tenancy, so a
hash reused two recycles back (A -> B -> A) is accepted.**
`render-core/src/lease.ts`'s clause (a) reads "the slot's `argon2id` hash
must be replaced on every recycle" — literally a one-step comparison, not
"never reused across the slot's history", and B -> A still replaces B's
hash. A -> B -> A is therefore within the contract as written: the previous
visitor (B) cannot log in again, which is the property clause (a)
protects; only a visitor from two tenancies ago could, and only by guessing
that history and the current passphrase. A bounded history would close
that narrower residual risk, but nothing in the contract requires it, so
this stays a one-step check until the contract itself changes.

## recoverSwapInFlight

Recovers a slot found `swapping` at boot — a crash partway through
`attemptColourSwap`'s side effects (`app.ts`). Unlike `preparing`/
`resetting`, marking it blindly `error` is not safe here: something is
genuinely still serving traffic throughout a swap (that is the whole point
of the mechanism), and `error` would fail a colour closed that a caller
might otherwise still be able to reach correctly if this function simply
told the truth about which one it is.

**Never trusts the stale persisted state to say which colour is live.**
`state.colour` is the swap's own *source* — correct only for as long as the
swap it was reading never got far enough to move traffic, and this
function's whole reason to exist is that it might have. Re-derives
liveness from the two real signals a running colour has to have: its drain
flag clear, *and* Ghost itself answering at its own app port — the same
two conditions `services/drain-sidecar` combines into one `/healthz`
verdict, checked here directly rather than through the sidecar (this runs
at broker boot, before any caller has reached the edge at all). Each check
polls with `waitUntilReady`, the swap's own bring-up semantics, rather than
a single probe: Ghost's post-boot maintenance window (a couple of seconds,
`ghostReadiness.ts`) would otherwise read a genuinely-healthy colour as
not-ready on the one unlucky instant this runs at, and a false `error` here
sends an operator toward `/reset`, which stops *both* colours.

**Direction matters, and the two directions are not symmetric.** Deploying
into `'a'` (first-listed): clearing its flag is already the one flag change
that moves everything, and the source (`'b'`) is never drained at all by
that direction's own design — a live source alongside a live target is the
*intended* end state, not a fault. Deploying into `'b'` (second-listed):
clearing its flag moves *nothing* on its own (`'a'` is still preferred);
only draining `'a'` afterwards actually moves traffic. So for
`target === 'b'`, "the target is live" is not the same question as "the
swap moved traffic" — both colours can be live and undrained at once, in
the exact window between `attemptColourSwap` clearing `'b'`'s flag and
draining `'a'`, and a crash there must never be read as success while `'a'`
is still what every real reader is actually being served from.

**"Target live" means "target rebuilt" only because of an ordering
`attemptColourSwap` guarantees:** it drains the target *before* writing
this marker, and nothing clears that flag again until the target has been
rebuilt and verified. The target is routinely left live and undrained by
the previous swap in the other direction, still running the version before
last; without that ordering, a crash just after the marker would present
that stale colour here as the rebuilt one.

Per-direction outcomes:
- **`target === 'a'`**: target live -> adopt it (source's own state is
  irrelevant, by the direction's own design, above). Otherwise source
  live -> revert to it. Otherwise -> `error`.
- **`target === 'b'`**: target live *and* source already drained -> the
  swap's own traffic-moving step already ran before the crash; adopt the
  target. Target live *and* source still live -> the dangerous window
  itself: re-verifies the target directly (mirroring `attemptColourSwap`'s
  own second, independent check immediately before its one traffic-moving
  step) and, if it still holds, completes the interrupted drain of the
  source right here before adopting the target — never adopts with both
  colours left live. If that re-verification fails, falls through to the
  source-liveness check below exactly as if the target had never been
  confirmed at all. Otherwise (target not live) -> source live -> revert to
  it. Otherwise -> `error`.

## recoverStoppingSlot

Recovers a slot found `stopping` at boot — a crash between
`attemptStopOldColour` calling `wrapper.stop` and its own final
`writeSlotState`. Unlike `recoverSwapInFlight`, which colour to act on is
never ambiguous: `state.colour` already names the survivor by construction
(a `stopping` write is only ever reached from a `running` state with
`colour` set), so the other colour is unambiguous, and stopping it is
idempotent — `systemctl stop` on an already-stopped unit is a no-op.

**Still re-checks the survivor is live before retrying, exactly like
`attemptStopOldColour`'s own third check, immediately before its call to
`wrapper.stop` (`app.ts`).** A crash can land here for reasons that have
nothing to do with the stop itself — the survivor can have gone unhealthy
in the gap between the original attempt and this reboot — and retrying
`wrapper.stop` on the other colour in that world is exactly the fault "no
step may ever leave a tenant with no colour serving" exists to refuse
mid-swap: it would remove the *only* colour with any chance of being live.
Idempotence of the stop call says nothing about whether it is still *safe*
to make; only re-deriving liveness, not the stale persisted phase, answers
that. If the survivor is not confirmed live, this marks the slot `error`
instead of stopping anything — the same fail-closed outcome
`recoverSwapInFlight` reaches when neither colour is confirmed live, rather
than a boot-time retry that stops the other colour unconditionally, with
no liveness re-check at all.

## recoverCrashedSlots

Boot-time recovery for a slot whose lock holder died mid-transition. The
per-slot lock lives in process memory (`slotLock.ts`), so it never survives
a restart — a persisted `preparing` or `resetting` phase found here can
only be left over from a process that crashed before reaching `free`,
`running` or `error`.

Fail-closed, chosen deliberately over guessing the slot back to `free` or
`running`: nothing at boot knows how far the crashed attempt got, so
silently resuming it could hand a caller a slot whose rendered artefacts,
wrapper state and lease disagree with each other. Marking it `error`
instead reuses the phase this broker already answers with "something went
wrong; call `/reset`" (`handleReconcile`'s own retry-then-error path), so
every caller already knows how to recover it, and `GET /status` — a
deliberately unauthenticated, always-answering endpoint — reports it
distinctly from a live `preparing` rather than looking identical to one
still genuinely in flight.

The phase alone is not enough for a slot recovered from `resetting`:
`handleReset` writes `resetting` *before* it revokes the previous tenancy's
lease and hash, so a crash in that narrow window leaves them live while the
phase already says "being torn down". Marking it `error` without also
revoking would fail the phase closed while leaving access open — the
previous visitor keeps logging in for however long it takes an operator to
notice and call `/reset`. Revoking here first, the same order `handleReset`
itself uses, closes that gap immediately rather than waiting on a caller. A
slot recovered from `preparing`, by contrast, has no previous tenancy's
access to revoke: whatever lease exists there (if any got as far as being
written) belongs to the new tenancy that never finished starting, not to
one still logging in.

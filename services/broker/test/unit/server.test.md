# server.test.ts

## crash-after-swap-recovery

End to end through the real spawned entrypoint — a process died right
after a colour swap safely reached its target (the target's flag cleared,
the source's drained), before its own final `writeSlotState` ran.
Pre-seeds exactly the `swapping` state and drain-flag files
`attemptColourSwap` would have left at that instant (see app.test.ts's
"writes the swapping marker" test for the deterministic proof that it
really does write this, before any side effect). Recovery must adopt the
target, and a retried /reconcile with the same new descriptor must hit the
idempotent branch — returning immediately, touching no flag and draining
nothing a second time — rather than believing the stale source is still
live.

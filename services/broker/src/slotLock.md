# slotLock.ts

## SlotLock

Serialises `/reconcile` and `/reset` per slot: a reset racing an in-flight
reconcile must not leave the slot `free` while the tenancy's hash and lease
stay live, and two different descriptors racing one free slot must not both
proceed.

`claim` and its caller's check of the result run with no `await` between
them, so two concurrent handlers reading `claim()` cannot both see `true`
for the same slot — Node runs one JS turn at a time, and nothing here
yields the event loop mid-check. The persisted phase in `stateStore.ts`
records the *result* for `/status`; this is the actual concurrency control;
the persisted file is not (a read there is async and cannot be used to
decide who may proceed).

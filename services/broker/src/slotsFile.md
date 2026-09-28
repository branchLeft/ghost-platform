# slotsFile.ts

## upsertSlotEntry

Replaces whatever entry currently names `slot` (by slot, not by host — a
recycle can legitimately change a demo's hostname) with `entry`, and
refuses outright if `entry.host` is already held by a *different* slot.

The whole read-modify-write runs inside `mutexFor(path)`, which is the only
thing that makes this atomic: a per-slot lock (`slotLock.ts`) stops two
requests racing the *same* slot, but this file is shared across every slot,
so two different slots reconciling concurrently — each holding its own,
different per-slot lock — would otherwise still interleave their reads and
writes here and lose entries. There is no flock to rely on either: the
sudoers-enumerated wrapper's own per-slot flock spans one privileged
invocation, never this file, and does not exist yet.

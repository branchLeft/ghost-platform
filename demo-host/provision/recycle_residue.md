# recycle_residue.py

## What it is for

The host half of the recycle's residue check (workspace#1657). After a slot is
reset, `residue_of(slot, content_volume)` lists whatever of the previous
occupant is still where `branchleft_slot` should have emptied it: the slot
directory, both colours' environment files (`demo-<slot>-a.env`,
`demo-<slot>-b.env`, which carry the slot's mail key and Ghost settings), and
the contents of the slot's data and content volumes. An empty list means the
host holds nothing of the last lease.

It reads the wrapper's own constants (`SLOT_DIR`, `ETC_DIR`,
`DOCKER_VOLUME_ROOT`, `COLOURS`) so the check and the wipe cannot drift to two
different places. The adapters volume is not looked at: it is platform code, not
tenant state, and the wrapper never touches it.

## What it does not cover

The gate cookie, the unsent mail and the hostname's retirement are not on the
host's filesystem as the wrapper sees them: the broker's `recycle.test.ts`
checks the lease record and the gate entry, `mailgun-shim`'s
`storeLeasePurge.test.ts` checks the spool, and `portal/data`'s
`hostnameRegister.test.ts` checks the register.

## How a find is read

A symlink is reported by name and never followed: a link planted in a volume is
residue, and what it points at is not the check's business. A directory that is
itself a link, or a path that does not exist, reports nothing: a volume that was
never created has nothing in it.

## The sabotage

`test_recycle_residue.py` plants each kind of residue (a file in the data volume,
in the content volume, a dotfile deep in the slot directory, a stale environment
file, a link) and requires the check to name it. `sabotage_recycle_residue.py`
then loosens the wrapper itself, one wipe at a time, in a scratch copy and
requires that suite red, and green on the real copy.

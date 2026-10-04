# drain_flag_dir.py

## Module overview

Provisions the demo host's drain-flag directory, once, at host build.

## Where the flag lives

LLD-2 §01b's own text puts the flag "in the slot directory, owned by the
broker user". That directory is root-owned and is exactly what a slot's
`reset` wipes and recreates (`branchleft_slot.py`'s `ResetInvocation`
path) -- so a flag living there cannot survive a reset, and "a new colour
must boot drained" needs the flag to already exist *before* that colour's
first start, which can follow a reset with no gap. Put the flag inside the
slot directory and "boots drained by default" and "reset wipes the slot"
contradict each other; both are load-bearing, so one of them has to give.

The decision this module settles: the flag directory is its own path,
outside every slot directory, owned and writable by the broker account
alone, under the broker unit's own state directory
(`/var/lib/branchleft-broker`, systemd `StateDirectory=`), which is the path
the broker's `BROKER_DRAIN_FLAG_DIR` already names. It is never touched by `reset` (which only ever wipes
`/opt/branchleft/demo-<slot>/` and the two
`/etc/branchleft/demo-<slot>-<colour>.env` files -- `branchleft_slot.py`'s
`perform()`), so a flag this module preseeds at host build stays present
across every reset a slot ever goes through, without the wrapper needing
to know the flag directory exists at all. This matches
`services/broker/src/drainFlag.ts`'s own docstring, which already assumed
exactly this shape ("deliberately outside the slot's own root-owned
directory") without this module existing yet to provision it.

## The permission shape

From the review of the health sidecar's own container proof: broker-owned,
broker-writable, and readable and traversable (`r-x`) by uid 1000 -- the
sidecar's own uid, baked into the `node:*-bookworm-slim` base image --
without being world-writable. 0755 under a broker-owned directory gives
uid 1000 exactly `r-x` as "other", which is what
`scripts/test-drain-sidecar.sh` already asserts for its own throwaway flag
directory; this module is what gives a real host directory that same
shape rather than a test-only stand-in. No slot uid (30001..30007, or any
other) is ever the owner or the group, so none of them has write access
either -- only `root` and the broker account itself can write here. The parent,
`/var/lib/branchleft-broker`, is broker-owned 0750, the shape the unit's
`StateDirectoryMode=` re-applies at every broker start.

## Why the directory is on disk, not in `/run`

The design says a new colour always boots drained, and that the broker
recovers a swap in flight by reading these flags at start. Both need a flag
to outlast a reboot: with the flags gone, a colour that was drained comes
back undrained next to the live one and the edge splits traffic between two
versions, and a missing directory makes `docker run --mount type=bind`
refuse to start any sidecar. `/run` and `/var/run` are tmpfs on the demo
host, so neither can hold them.

The one source of truth is
`drain-flag-dir.golden.json`: the broker's env template is tested against it
in `services/broker/test/unit/drainFlagDirGolden.test.ts`, and this module and
`demo_sidecar.py` in `test_drain_flag_dir.py`.

## Preseeding, not merely creating the directory

`preseed_drain_flags` touches one empty file per (slot, colour) if it is
not already there -- never overwriting an existing flag's presence or
absence, because a flag already cleared by a running colour must not be
put back by a re-run of host build. "A new colour must boot drained"
(LLD-2 §01b) needs the flag to exist for a (slot, colour) that has never
started at all, and this is the one place that is true before the broker
ever runs.

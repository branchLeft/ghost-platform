#!/usr/bin/env python3
"""Provisions the demo host's drain-flag directory, once, at host build.

**Where the flag lives -- the decision this story settles.** LLD-2 §01b's
own text puts the flag "in the slot directory, owned by the broker user".
That directory is root-owned and is exactly what a slot's `reset` wipes and
recreates (`branchleft_slot.py`'s `ResetInvocation` path) -- so a flag
living there cannot survive a reset, and "a new colour must boot drained"
needs the flag to already exist *before* that colour's first start, which
can follow a reset with no gap. Put the flag inside the slot directory and
"boots drained by default" and "reset wipes the slot" contradict each
other; both are load-bearing, so one of them has to give a decision this
story owns to make.

The decision: **the flag directory is its own path, outside every slot
directory, owned and writable by the broker account alone.** It is never
touched by `reset` (which only ever wipes `/opt/branchleft/demo-<slot>/`
and the two `/etc/branchleft/demo-<slot>-<colour>.env` files --
`branchleft_slot.py`'s `perform()`), so a flag this module preseeds at
host build stays present across every reset a slot ever goes through,
without the wrapper needing to know the flag directory exists at all. This
matches `services/broker/src/drainFlag.ts`'s own docstring, which already
assumed exactly this shape ("deliberately outside the slot's own
root-owned directory") without this module existing yet to provision it.

**The permission shape, from the review of the health sidecar's own
container proof:** broker-owned, broker-writable, and readable and
traversable (`r-x`) by uid 1000 -- the sidecar's own uid, baked into the
`node:*-bookworm-slim` base image -- without being world-writable. 0755
under a broker-owned directory gives uid 1000 exactly `r-x` as "other",
which is what `scripts/test-drain-sidecar.sh` already asserts for its own
throwaway flag directory; this module is what gives a real host directory
that same shape rather than a test-only stand-in. No slot uid (30001..
30007, or any other) is ever the owner or the group, so none of them has
write access either -- only `root` (who owns the parent, `/var/run/
branchleft`) and the broker account itself can write here.

**Preseeding, not merely creating the directory:** `preseed_drain_flags`
touches one empty file per (slot, colour) if it is not already there --
never overwriting an existing flag's presence or absence, because a flag
already cleared by a running colour must not be put back by a re-run of
host build. "A new colour must boot drained" (LLD-2 §01b) needs the flag
to exist for a (slot, colour) that has never started at all, and this is
the one place that is true before the broker ever runs.
"""

from __future__ import annotations

import argparse
import os
import pwd
import sys
from typing import Sequence

from render_slot_sudoers import COLOURS, SLOT_NAMES

DEFAULT_FLAG_DIR = "/var/run/branchleft/drain-flags"
DEFAULT_BROKER_USER = "broker"

# Matches services/broker/src/drainFlag.ts's own `flagPath` exactly -- the
# broker is the only writer of the real file, but the *name* is a shared
# contract this module has to reproduce precisely, or a preseeded flag and
# the broker's own clear()/set() would silently miss each other.
FLAG_FILE_MODE = 0o644


class DrainFlagProvisionError(Exception):
    """Raised for anything a caller could have avoided, or that the host
    refused -- never masked, because a silent failure here means a demo
    host built without a drain-flag boundary at all."""


def flag_file_name(slot: str, colour: str) -> str:
    return f"{slot}-{colour}.drain"


def resolve_broker_ids(broker_user: str) -> tuple[int, int]:
    try:
        entry = pwd.getpwnam(broker_user)
    except KeyError as exc:
        raise DrainFlagProvisionError(
            f"broker account {broker_user!r} does not exist on this host -- "
            "create it before provisioning the drain-flag directory"
        ) from exc
    return entry.pw_uid, entry.pw_gid


def provision_drain_flag_dir(
    path: str = DEFAULT_FLAG_DIR,
    *,
    broker_uid: int,
    broker_gid: int,
) -> None:
    """Idempotent: safe to run again at every host-build pass. Ownership and
    mode are asserted every run, not only on first creation, so a directory
    a previous partial run left in the wrong shape is corrected rather than
    trusted.
    """
    os.makedirs(path, exist_ok=True)
    os.chown(path, broker_uid, broker_gid)
    os.chmod(path, 0o755)


def preseed_drain_flags(
    path: str = DEFAULT_FLAG_DIR,
    slots: Sequence[str] = SLOT_NAMES,
    colours: Sequence[str] = COLOURS,
) -> list[str]:
    """Touches one empty flag file per (slot, colour) that is not already
    there. Returns the list of files actually created, so a caller (or a
    test) can tell a fresh preseed from a no-op re-run without re-deriving
    the slot table itself.
    """
    created: list[str] = []
    for slot in slots:
        for colour in colours:
            flag_path = os.path.join(path, flag_file_name(slot, colour))
            if os.path.exists(flag_path):
                continue
            fd = os.open(flag_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, FLAG_FILE_MODE)
            os.close(fd)
            os.chmod(flag_path, FLAG_FILE_MODE)  # O_CREAT's mode is masked by umask
            created.append(flag_path)
    return created


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", default=DEFAULT_FLAG_DIR)
    parser.add_argument("--broker-user", default=DEFAULT_BROKER_USER)
    args = parser.parse_args(argv)

    try:
        broker_uid, broker_gid = resolve_broker_ids(args.broker_user)
        provision_drain_flag_dir(args.path, broker_uid=broker_uid, broker_gid=broker_gid)
        created = preseed_drain_flags(args.path)
    except DrainFlagProvisionError as exc:
        print(f"drain_flag_dir: {exc}", file=sys.stderr)
        return 1

    print(f"drain-flag directory ready at {args.path} (owner {args.broker_user})")
    print(f"preseeded {len(created)} new flag file(s)" if created else "no new flags to preseed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

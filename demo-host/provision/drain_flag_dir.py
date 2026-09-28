#!/usr/bin/env python3
"""Provisions the demo host's drain-flag directory, once, at host build.

See drain_flag_dir.md for why the flag directory sits outside every slot
directory (a `reset` wipes the slot directory, and the flag must survive
that), the permission shape the health sidecar's own uid needs, and why
preseeding never overwrites a flag a running colour already cleared.
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

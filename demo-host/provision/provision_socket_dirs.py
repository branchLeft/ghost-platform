#!/usr/bin/env python3
"""Creates the demo host's state directories under /var/lib/branchleft, once, at host build.

The root-owned state root, the router-owned 0700 socket directories per slot
and per colour under it, and the broker's own subdirectory beside them.
See provision_socket_dirs.md for the order to run it in and what it refuses.
"""

from __future__ import annotations

import argparse
import os
import pwd
import stat
import sys
from typing import Callable, Sequence

# Duplicated from `health_router.py` and `render_slot_sudoers.py`, because
# this file runs alone. `test_demo_sidecar.py` fails if any copy drifts.
SLOT_NAMES: tuple[str, ...] = tuple(str(n) for n in range(7))
COLOURS: tuple[str, ...] = ("a", "b")
ROUTER_USER = "demo-router"
ROUTER_UID = 30008
STATE_ROOT = "/var/lib/branchleft"
SOCKET_ROOT = "/var/lib/branchleft/demo-router"
BROKER_USER = "broker"
BROKER_SLOTS_DIR = "/var/lib/branchleft/broker-slots"
ROOT_MODE = 0o755
DIR_MODE = 0o700


class ProvisionError(Exception):
    """A directory is not the shape the router and the sidecars rely on.
    Refused, never corrected: a directory someone else could enter is one
    whose socket they could replace."""


def resolve_router(user: str = ROUTER_USER) -> tuple[int, int]:
    try:
        entry = pwd.getpwnam(user)
    except KeyError as exc:
        raise ProvisionError(
            f"account {user!r} does not exist; create it first: "
            f"useradd --system --uid {ROUTER_UID} --user-group --no-create-home "
            f"--shell /usr/sbin/nologin {user}"
        ) from exc
    if entry.pw_uid != ROUTER_UID:
        raise ProvisionError(f"account {user!r} has uid {entry.pw_uid}, expected {ROUTER_UID}")
    return entry.pw_uid, entry.pw_gid


def resolve_broker(user: str = BROKER_USER) -> tuple[int, int]:
    try:
        entry = pwd.getpwnam(user)
    except KeyError as exc:
        raise ProvisionError(f"account {user!r} does not exist; create it first") from exc
    return entry.pw_uid, entry.pw_gid


def _require_trusted_parent(path: str, owner_uid: int) -> None:
    """The directory holding the router's root must belong to `owner_uid`
    (root on a host) and be writable by nobody else. Whoever can write it can
    rename the router's root, and with it every socket the router trusts.
    Refused, never corrected: a parent the broker owns is a host built wrong."""
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise ProvisionError(f"{path} exists and is not a directory")
    if st.st_uid != owner_uid:
        raise ProvisionError(f"{path} is owned by uid {st.st_uid}, expected {owner_uid}")
    if st.st_mode & 0o022:
        raise ProvisionError(f"{path} is writable by someone other than its owner")


def _ensure(path: str, mode: int, owner: tuple[int, int], chown: Callable[..., None]) -> bool:
    created = False
    try:
        os.mkdir(path, mode)
        created = True
    except FileExistsError:
        pass
    if created:
        os.chmod(path, mode)
        chown(path, *owner)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise ProvisionError(f"{path} exists and is not a directory")
    if st.st_uid != owner[0]:
        raise ProvisionError(f"{path} is owned by uid {st.st_uid}, expected {owner[0]}")
    if stat.S_IMODE(st.st_mode) != mode:
        raise ProvisionError(
            f"{path} has mode {oct(stat.S_IMODE(st.st_mode))}, expected {oct(mode)}"
        )
    return created


def provision(
    root: str = SOCKET_ROOT,
    slots: Sequence[str] = SLOT_NAMES,
    *,
    owner: tuple[int, int] | None = None,
    root_owner_uid: int = 0,
    chown: Callable[..., None] = os.chown,
) -> list[str]:
    """Idempotent. Returns the directories newly created. The root is
    root-owned and not writable by anyone else; every slot and colour
    directory below it is router-owned 0700. A wrong shape is refused."""
    router = owner if owner is not None else resolve_router()
    created: list[str] = []
    parent = os.path.dirname(root)
    if not os.path.isdir(parent):
        os.makedirs(parent)
        os.chmod(parent, ROOT_MODE)
        chown(parent, root_owner_uid, 0)
    _require_trusted_parent(parent, root_owner_uid)
    if _ensure(root, ROOT_MODE, (root_owner_uid, 0), chown):
        created.append(root)
    for slot in slots:
        slot_dir = os.path.join(root, slot)
        if _ensure(slot_dir, DIR_MODE, router, chown):
            created.append(slot_dir)
        for colour in COLOURS:
            colour_dir = os.path.join(slot_dir, colour)
            if _ensure(colour_dir, DIR_MODE, router, chown):
                created.append(colour_dir)
    return created


def provision_broker_slots_dir(
    path: str = BROKER_SLOTS_DIR,
    *,
    broker: tuple[int, int] | None = None,
    root_owner_uid: int = 0,
    chown: Callable[..., None] = os.chown,
) -> bool:
    """The one directory under the state root the broker may write. The state
    root itself stays root-owned, so the broker cannot rename anything in it
    but its own subdirectory's contents. True when newly created."""
    owner = broker if broker is not None else resolve_broker()
    _require_trusted_parent(os.path.dirname(path), root_owner_uid)
    return _ensure(path, ROOT_MODE, owner, chown)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=SOCKET_ROOT)
    parser.add_argument("--broker-slots-dir", default=BROKER_SLOTS_DIR)
    args = parser.parse_args(argv)
    try:
        created = provision(args.root)
        if provision_broker_slots_dir(args.broker_slots_dir):
            print(f"created {args.broker_slots_dir}")
    except (ProvisionError, OSError) as exc:
        print(f"provision_socket_dirs: {exc}", file=sys.stderr)
        return 1
    print(f"socket directories ready under {args.root}; {len(created)} created")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

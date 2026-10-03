#!/usr/bin/env python3
"""Creates the demo host's sidecar socket directories, once, at host build.

Run by hand as root after demo_uid_claims.py and after the `demo-router`
account exists. Runs alone. Creates, router-owned 0700:

    <root>/<slot>/        one per slot
    <root>/<slot>/a/      mounted only into colour a's sidecar
    <root>/<slot>/b/      mounted only into colour b's sidecar

See provision_socket_dirs.md for what each refusal means.

Exit 0 on success, 1 on any refusal or failure.
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
SOCKET_ROOT = "/var/lib/branchleft/demo-router"
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
    os.makedirs(os.path.dirname(root), exist_ok=True)
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=SOCKET_ROOT)
    args = parser.parse_args(argv)
    try:
        created = provision(args.root)
    except (ProvisionError, OSError) as exc:
        print(f"provision_socket_dirs: {exc}", file=sys.stderr)
        return 1
    print(f"socket directories ready under {args.root}; {len(created)} created")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

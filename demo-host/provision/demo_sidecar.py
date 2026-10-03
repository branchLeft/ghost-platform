#!/usr/bin/env python3
"""Starts and stops one demo colour's drain sidecar, from that colour's unit.

Installed at /usr/local/lib/branchleft/demo_sidecar.py and run as root by
the colour unit's ExecStartPost (`start`) and by both its ExecStop and
ExecStopPost (`stop`). Runs alone: it imports nothing from this repository.
See demo_sidecar.md for what start refuses, what it mounts, and why a failed
start removes the container it may have created.

Exit 0 on success, 1 on any refusal or failure.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import sys
from typing import Callable, Mapping, Sequence

# Duplicated from `health_router.py`, `render_slot_sudoers.py` and
# `drain_flag_dir.py`, because this file runs alone on the host.
# `test_demo_sidecar.py` fails if any copy drifts.
SLOT_NAMES: tuple[str, ...] = tuple(str(n) for n in range(7))
COLOURS: tuple[str, ...] = ("a", "b")
ROUTER_UID = 30008
SOCKET_ROOT = "/var/lib/branchleft/demo-router"
SOCKET_NAME = "health.sock"
SOCKET_DIR_MODE = 0o700
SLOT_DIR = "/opt/branchleft/demo-{slot}"
FLAG_DIR = "/var/run/branchleft/drain-flags"
FLAG_FILE = "{slot}-{colour}.drain"

# Mirrors render-core's GHOST_CONTAINER_PORT, which the sidecar probes over
# the loopback it shares with Ghost.
GHOST_CONTAINER_PORT = 2368

DOCKER = "/usr/bin/docker"
IMAGE_VARIABLE = "DEMO_SIDECAR_IMAGE"
IMAGE_PATTERN = re.compile(r"\A[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}\Z")
CONTAINER_ID_PATTERN = re.compile(r"\A[0-9a-f]{12,64}\Z")

CONTAINER_SOCKET_DIR = "/run/sidecar"
CONTAINER_FLAG_DIR = "/run/drain"
PIDS_LIMIT = "64"
MEMORY_LIMIT = "128m"
COMMAND_TIMEOUT_SECONDS = 60

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class SidecarError(Exception):
    """Anything that stops a sidecar from being started the way it was
    approved to be. Never masked: a colour without its sidecar is a colour
    the router answers 503 for, which is the safe state, so refusing loudly
    costs nothing."""


def container_name(slot: str, colour: str) -> str:
    _check_names(slot, colour)
    return f"demo-{slot}-{colour}-sidecar"


def _check_names(slot: str, colour: str) -> None:
    if slot not in SLOT_NAMES or colour not in COLOURS:
        raise SidecarError(f"unknown slot or colour: {slot!r} {colour!r}")


def validate_image(value: str | None) -> str:
    """The pinned reference, or a refusal. Only `name@sha256:<64 hex>` is
    accepted: a tag can be moved after it was approved, a digest cannot."""
    if not value or not IMAGE_PATTERN.match(value):
        raise SidecarError(
            f"{IMAGE_VARIABLE} must be a repository pinned by digest (name@sha256:<64 hex>)"
        )
    return value


def _require_dir(path: str, owner_uid: int) -> None:
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise SidecarError(f"{path} cannot be inspected ({exc.strerror})") from exc
    if not stat.S_ISDIR(st.st_mode):
        raise SidecarError(f"{path} is not a directory")
    if st.st_uid != owner_uid:
        raise SidecarError(f"{path} is owned by uid {st.st_uid}, expected {owner_uid}")
    if stat.S_IMODE(st.st_mode) != SOCKET_DIR_MODE:
        raise SidecarError(f"{path} has mode {oct(stat.S_IMODE(st.st_mode))}, expected 0o700")


def verify_colour_dir(root: str, slot: str, colour: str, owner_uid: int) -> str:
    """The colour's socket directory, once it and the slot directory above it
    are both known to be router-owned 0700 and not symlinks."""
    _check_names(slot, colour)
    _require_dir(os.path.join(root, slot), owner_uid)
    path = os.path.join(root, slot, colour)
    _require_dir(path, owner_uid)
    return path


def run_arguments(
    slot: str,
    colour: str,
    *,
    ghost_id: str,
    image: str,
    colour_dir: str,
    flag_dir: str = FLAG_DIR,
    owner_uid: int = ROUTER_UID,
    docker: str = DOCKER,
) -> list[str]:
    """The whole `docker run`, as an argument list that never meets a shell.
    The only socket directory mounted is this colour's own subdirectory."""
    return [
        docker, "run", "-d",
        "--name", container_name(slot, colour),
        "--network", f"container:{ghost_id}",
        "--user", f"{owner_uid}:{owner_uid}",
        "--restart", "no",
        "--pull", "never",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", PIDS_LIMIT,
        "--memory", MEMORY_LIMIT,
        "--mount", f"type=bind,src={colour_dir},dst={CONTAINER_SOCKET_DIR}",
        "--mount", f"type=bind,src={flag_dir},dst={CONTAINER_FLAG_DIR},readonly",
        "-e", f"SOCKET_PATH={CONTAINER_SOCKET_DIR}/{SOCKET_NAME}",
        "-e", f"DRAIN_FLAG_PATH={CONTAINER_FLAG_DIR}/{FLAG_FILE.format(slot=slot, colour=colour)}",
        "-e", f"GHOST_HEALTH_URL=http://127.0.0.1:{GHOST_CONTAINER_PORT}/",
        image,
    ]  # fmt: skip


def _run(run: Runner, argv: Sequence[str], **kwargs: object) -> "subprocess.CompletedProcess[str]":
    try:
        return run(
            list(argv), capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS, **kwargs
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SidecarError(f"{argv[0]} {' '.join(argv[1:3])}: {exc}") from exc


def ghost_container_id(
    slot: str, colour: str, *, run: Runner, slot_dir: str, docker: str = DOCKER
) -> str:
    """The running container of this slot's Ghost for this colour, asked of
    the slot's own Compose project. Exactly one running container or a
    refusal: joining the wrong network namespace would put this sidecar
    beside a different Ghost."""
    result = _run(run, [docker, "compose", "ps", "-q", f"ghost-{colour}"], cwd=slot_dir)
    ids = result.stdout.split()
    if result.returncode != 0 or len(ids) != 1 or not CONTAINER_ID_PATTERN.match(ids[0]):
        raise SidecarError(f"ghost-{colour} of slot {slot} is not a single running container")
    return ids[0]


def remove(slot: str, colour: str, *, run: Runner, docker: str = DOCKER) -> None:
    """Removes the sidecar container, running or not. Absent is success."""
    name = container_name(slot, colour)
    result = _run(run, [docker, "rm", "-f", name])
    if result.returncode == 0:
        return
    still_there = _run(run, [docker, "container", "inspect", name])
    if still_there.returncode == 0:
        raise SidecarError(f"could not remove container {name}: {result.stderr.strip()}")


def start(
    slot: str,
    colour: str,
    *,
    env: Mapping[str, str],
    run: Runner = subprocess.run,
    root: str = SOCKET_ROOT,
    owner_uid: int = ROUTER_UID,
    slot_dir: str | None = None,
    flag_dir: str = FLAG_DIR,
    docker: str = DOCKER,
) -> None:
    """Refuses before creating anything when the image is not a digest pin or
    the socket directories are not router-owned 0700. Once a container may
    exist, any failure removes it before raising, so a failed start leaves
    nothing running; the unit's ExecStopPost removes it again regardless."""
    image = validate_image(env.get(IMAGE_VARIABLE))
    colour_dir = verify_colour_dir(root, slot, colour, owner_uid)
    resolved_slot_dir = slot_dir if slot_dir is not None else SLOT_DIR.format(slot=slot)
    ghost_id = ghost_container_id(slot, colour, run=run, slot_dir=resolved_slot_dir, docker=docker)
    remove(slot, colour, run=run, docker=docker)
    try:
        result = _run(
            run,
            run_arguments(
                slot, colour, ghost_id=ghost_id, image=image, colour_dir=colour_dir,
                flag_dir=flag_dir, owner_uid=owner_uid, docker=docker,
            ),
        )  # fmt: skip
        if result.returncode != 0:
            raise SidecarError(f"docker run failed: {result.stderr.strip()}")
    except BaseException:
        try:
            remove(slot, colour, run=run, docker=docker)
        except SidecarError:
            pass
        raise


def stop(slot: str, colour: str, *, run: Runner = subprocess.run, docker: str = DOCKER) -> None:
    remove(slot, colour, run=run, docker=docker)


def main(argv: list[str] | None = None, *, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("verb", choices=("start", "stop"))
    parser.add_argument("slot")
    parser.add_argument("colour")
    parser.add_argument("--socket-root", default=SOCKET_ROOT)
    parser.add_argument("--owner-uid", type=int, default=ROUTER_UID)
    parser.add_argument("--slot-dir")
    parser.add_argument("--flag-dir", default=FLAG_DIR)
    parser.add_argument("--docker", default=DOCKER)
    args = parser.parse_args(argv)
    try:
        if args.verb == "start":
            start(
                args.slot, args.colour, env=os.environ if env is None else env,
                root=args.socket_root, owner_uid=args.owner_uid, slot_dir=args.slot_dir,
                flag_dir=args.flag_dir, docker=args.docker,
            )  # fmt: skip
        else:
            stop(args.slot, args.colour, docker=args.docker)
    except SidecarError as exc:
        print(f"demo_sidecar: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

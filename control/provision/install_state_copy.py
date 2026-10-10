#!/usr/bin/env python3
"""Installs the state-copy units next to the backup worker's release and
enables the timer only once the credential file and the tools are in place.
Idempotent. See install_state_copy.md."""

from __future__ import annotations

import argparse
import dataclasses
import os
import pathlib
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import install_backup_worker as ibw  # noqa: E402

SERVICE_UNIT = "branchleft-state-copy.service"
TIMER_UNIT = "branchleft-state-copy.timer"
UNIT_FILES = (SERVICE_UNIT, TIMER_UNIT)
REQUIRED_RELEASE_FILES = (
    "infra/provisioning/scripts/state_copy.py",
    "infra/provisioning/scripts/media_backup_restore.py",
    "infra/provisioning/scripts/shared_objectstorage.py",
    "db/provision/objectstorage.py",
    *(f"control/provision/{name}" for name in UNIT_FILES),
)
# The names state_copy.load_config reads: five per bucket, three buckets, and the recipient.
REQUIRED_ENV_NAMES = ("STATE_COPY_RECIPIENT",) + tuple(
    f"STATE_COPY_{who}_{n}"
    for who in ("DEST", "ESTATE", "TENANT")
    for n in ("BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")
)


@dataclasses.dataclass(frozen=True)
class Paths:
    releases_dir: pathlib.Path = pathlib.Path("/opt/branchleft/backup-worker/releases")
    current_link: pathlib.Path = pathlib.Path("/opt/branchleft/backup-worker/current")
    unit_dir: pathlib.Path = pathlib.Path("/etc/systemd/system")
    env_file: pathlib.Path = pathlib.Path("/etc/branchleft/state-copy.env")


def env_problems(path: pathlib.Path, *, owner_uid: int = 0) -> list[str]:
    """Names only, never values."""
    try:
        info, raw = ibw._open_root_file(path)
    except FileNotFoundError:
        return [f"{path} does not exist"]
    except OSError as exc:
        return [f"{path} cannot be read safely: {exc}"]
    problems = []
    if info.st_uid != owner_uid:
        problems.append(f"{path} must be owned by uid {owner_uid}")
    if info.st_mode & 0o077:
        problems.append(f"{path} must be mode 0600 -- it holds credentials")
    values = {}
    for line in raw.decode("utf-8", errors="replace").splitlines():
        match = ibw._ENV_LINE.match(line.strip())
        if match:
            values[match.group(1)] = match.group(2)
    problems += [f"{path} does not set {n}" for n in REQUIRED_ENV_NAMES if not values.get(n)]
    return problems


def readiness_problems(paths: Paths, *, owner_uid: int = 0,
                       which: Callable[[str], str | None] = shutil.which) -> list[str]:
    return env_problems(paths.env_file, owner_uid=owner_uid) + [
        f"{tool} is not installed" for tool in ("age",) if which(tool) is None
    ]


def check_release(release_root: pathlib.Path, paths: Paths, *, owner_uid: int = 0) -> None:
    missing = [n for n in REQUIRED_RELEASE_FILES if not (release_root / n).is_file()]
    if missing:
        raise ibw.InstallError(f"release {release_root} is missing {', '.join(missing)}")
    ibw.check_release(release_root, dataclasses.replace(ibw.Paths(), releases_dir=paths.releases_dir),
                      owner_uid=owner_uid)


def install(release_root, paths: Paths, run, *, owner_uid: int = 0,
            which: Callable[[str], str | None] = shutil.which) -> list[str]:
    check_release(release_root, paths, owner_uid=owner_uid)
    ibw.ensure_service_user(run)
    if ibw.install_units(release_root, paths.unit_dir, UNIT_FILES):
        run(["systemctl", "daemon-reload"], check=True)
    problems = readiness_problems(paths, owner_uid=owner_uid, which=which)
    if problems:
        run(["systemctl", "disable", "--now", TIMER_UNIT], check=True)
        return problems
    run(["systemctl", "enable", "--now", TIMER_UNIT], check=True)
    return []


def main(argv: Sequence[str] | None = None, *, run=subprocess.run, paths: Paths | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="report what is missing; change nothing")
    args = parser.parse_args(argv)
    paths = paths or Paths()
    if args.check:
        problems = readiness_problems(paths)
    else:
        if os.geteuid() != 0:
            print("install_state_copy: must run as root", file=sys.stderr)
            return 1
        try:
            problems = install(ibw.release_root_of(pathlib.Path(__file__)), paths, run)
        except (ibw.InstallError, OSError, subprocess.CalledProcessError) as exc:
            print(f"install_state_copy: {exc}", file=sys.stderr)
            return 1
    for problem in problems:
        print(f"install_state_copy: missing: {problem}", file=sys.stderr)
    if problems:
        print(f"install_state_copy: {TIMER_UNIT} NOT enabled (disabled if it was)", file=sys.stderr)
        return 2
    print("install_state_copy: ready")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

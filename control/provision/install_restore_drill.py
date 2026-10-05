#!/usr/bin/env python3
"""Installs the weekly restore drill's units on the control host, from the
same staged release the backup worker runs, and enables its timer only once
every input the drill needs is in place. Idempotent. See
install_restore_drill.md.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable, Sequence

import install_backup_worker as ibw

SERVICE_UNIT = "branchleft-restore-drill.service"
TIMER_UNIT = "branchleft-restore-drill.timer"
UNIT_FILES = (SERVICE_UNIT, TIMER_UNIT)

# Everything the drill loads at run time beyond what the worker already needs.
REQUIRED_RELEASE_FILES = (
    "infra/provisioning/scripts/restore_drill.py",
    "db/recovery/restore_drained.py",
    "control/provision/branchleft-restore-drill.service",
    "control/provision/branchleft-restore-drill.timer",
)

ENV_FILE = pathlib.Path("/etc/branchleft/restore-drill.env")
IDENTITY_DIR = pathlib.Path("/etc/branchleft/restore-drill/identities")

_SCRIPTS = pathlib.Path(__file__).resolve().parents[2] / "infra" / "provisioning" / "scripts"


def _drill_module():
    """restore_drill.py owns what its environment must hold; this reads that
    rather than keeping a second list."""
    if str(_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS))
    import restore_drill

    return restore_drill


def check_drill_release(release_root: pathlib.Path) -> None:
    missing = [name for name in REQUIRED_RELEASE_FILES if not (release_root / name).is_file()]
    if missing:
        raise ibw.InstallError(f"release {release_root} is missing {', '.join(missing)}")


def env_problems(path: pathlib.Path, *, owner_uid: int = 0) -> list[str]:
    """Problems with the drill's environment file, naming keys, never values."""
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
        problems.append(f"{path} must be mode 0600 -- it holds the drill's read credential")
    values: dict[str, str] = {}
    for line in raw.decode("utf-8", errors="replace").splitlines():
        match = ibw._ENV_LINE.match(line.strip())
        if match and not line.strip().startswith("#"):
            values[match.group(1)] = match.group(2)
    drill = _drill_module()
    try:
        drill.copies_from_env(values)
        drill.images_from_env(values)
    except drill.DrillConfigError as exc:
        problems.append(f"{path}: {_without_secrets(str(exc), values)}")
    return problems


def _without_secrets(message: str, values: dict[str, str]) -> str:
    """The drill's errors name variables, not values; this holds even if one
    ever quotes a credential back."""
    for name, value in values.items():
        if name.endswith(("ACCESS_KEY_ID", "SECRET_ACCESS_KEY")) and value:
            message = message.replace(value, "<value>")
    return message


def identity_problems(identity_dir: pathlib.Path, tenants: Sequence[str], *, owner_uid: int = 0) -> list[str]:
    """Each tenant's private key: root-only, in a root-only directory."""
    try:
        info = identity_dir.lstat()
    except FileNotFoundError:
        return [f"{identity_dir} does not exist"]
    if not stat.S_ISDIR(info.st_mode):
        return [f"{identity_dir} must be a directory"]
    problems = []
    if info.st_uid != owner_uid or info.st_mode & 0o077:
        problems.append(f"{identity_dir} must be owned by uid {owner_uid} and mode 0700")
    for tenant in tenants:
        path = identity_dir / f"{tenant}.key"
        try:
            key_info, raw = ibw._open_root_file(path)
        except FileNotFoundError:
            problems.append(f"no identity for {tenant} at {path}")
            continue
        except OSError as exc:
            problems.append(f"{path} cannot be read safely: {exc}")
            continue
        if key_info.st_uid != owner_uid or key_info.st_mode & 0o077:
            problems.append(f"{path} must be owned by uid {owner_uid} and mode 0600")
        if b"AGE-SECRET-KEY-1" not in raw:
            problems.append(f"{path} holds no age identity")
    return problems


def docker_problems(run: ibw.Runner, which: Callable[[str], str | None] = shutil.which) -> list[str]:
    if which("docker") is None:
        return ["docker is not installed"]
    if run(["docker", "version", "--format", "{{.Server.Version}}"], capture_output=True, check=False).returncode:
        return ["the docker daemon does not answer"]
    return []


def readiness_problems(
    paths: ibw.Paths,
    run: ibw.Runner,
    *,
    env_file: pathlib.Path = ENV_FILE,
    identity_dir: pathlib.Path = IDENTITY_DIR,
    owner_uid: int = 0,
    which: Callable[[str], str | None] = shutil.which,
) -> list[str]:
    problems = env_problems(env_file, owner_uid=owner_uid)
    try:
        tenants = _drill_module().read_tenants(str(paths.tenants_file))
    except OSError:
        tenants = []
        problems.append(f"{paths.tenants_file} cannot be read")
    if not tenants:
        problems.append(f"{paths.tenants_file} names no tenant to drill")
    problems += identity_problems(identity_dir, tenants, owner_uid=owner_uid)
    problems += docker_problems(run, which)
    return problems


def install(
    release_root: pathlib.Path,
    paths: ibw.Paths,
    run: ibw.Runner,
    *,
    env_file: pathlib.Path = ENV_FILE,
    identity_dir: pathlib.Path = IDENTITY_DIR,
    owner_uid: int = 0,
    which: Callable[[str], str | None] = shutil.which,
) -> list[str]:
    """Copies the units, then enables the timer only if nothing is missing;
    disables it otherwise. Refuses a release that `current` does not point
    at, so the drill never runs code the worker is not running."""
    ibw.check_release(release_root, paths, owner_uid=owner_uid)
    check_drill_release(release_root)
    current = paths.current_link
    if not current.is_symlink() or pathlib.Path(os.readlink(current)) != release_root:
        raise ibw.InstallError(
            f"{current} does not point at {release_root} -- run install_backup_worker.py from this release first"
        )
    if ibw.install_units(release_root, paths.unit_dir, UNIT_FILES):
        run(["systemctl", "daemon-reload"], check=True)
    problems = readiness_problems(
        paths, run, env_file=env_file, identity_dir=identity_dir, owner_uid=owner_uid, which=which
    )
    if problems:
        run(["systemctl", "disable", "--now", TIMER_UNIT], check=True)
        return problems
    run(["systemctl", "enable", "--now", TIMER_UNIT], check=True)
    return []


def main(argv: Sequence[str] | None = None, *, run: ibw.Runner = subprocess.run,
         paths: ibw.Paths | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="report what is missing; change nothing")
    args = parser.parse_args(argv)
    paths = paths or ibw.Paths()
    if args.check:
        problems = readiness_problems(paths, run)
    else:
        if os.geteuid() != 0:
            print("install_restore_drill: must run as root", file=sys.stderr)
            return 1
        try:
            problems = install(ibw.release_root_of(pathlib.Path(__file__)), paths, run)
        except (ibw.InstallError, OSError, subprocess.CalledProcessError) as exc:
            print(f"install_restore_drill: {exc}", file=sys.stderr)
            return 1
    if problems:
        for problem in problems:
            print(f"install_restore_drill: missing: {problem}", file=sys.stderr)
        print(f"install_restore_drill: {TIMER_UNIT} NOT enabled (disabled if it was)", file=sys.stderr)
        return 2
    print("install_restore_drill: ready" + ("" if args.check else f"; {TIMER_UNIT} enabled"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Installs the per-tenant backup worker on the control host, from a staged
release directory, and enables its nightly timer only once every input it
needs is in place. Idempotent. See install_backup_worker.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import grp
import os
import pathlib
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence

SERVICE_USER = "backup-worker"
SERVICE_UNIT = "branchleft-backup-worker.service"
TIMER_UNIT = "branchleft-backup-worker.timer"
UNIT_FILES = (SERVICE_UNIT, TIMER_UNIT)

# Everything the loop imports or loads by path at run time, relative to a
# release root. backup_worker.py resolves db/provision/ from its own location.
REQUIRED_RELEASE_FILES = (
    "infra/provisioning/scripts/nightly_dump_loop.py",
    "infra/provisioning/scripts/backup_worker.py",
    "infra/provisioning/scripts/dial_in_transport.py",
    "infra/provisioning/scripts/pull_encrypt_store.py",
    "infra/provisioning/scripts/media_backup_restore.py",
    "infra/provisioning/scripts/shared_objectstorage.py",
    "db/provision/dump_tenant.py",
    "db/provision/naming.py",
    "db/provision/objectstorage.py",
    "control/provision/branchleft-backup-worker.service",
    "control/provision/branchleft-backup-worker.timer",
)

# The names nightly_dump_loop.main() and backup_worker's required copy read.
# test_install_backup_worker.py ties this list to those modules' source.
REQUIRED_ENV_NAMES = (
    "BACKUP_WORKER_DB_HOST",
    "BACKUP_WORKER_MYSQL_USER",
    "BACKUP_WORKER_MYSQL_SSL_CA",
    "DB_DUMP_MYSQL_PWD",
    "AGE_RECIPIENT_PUBLIC_KEY",
    "BACKUP_WORKER_COPY_PRIMARY_BUCKET",
    "BACKUP_WORKER_COPY_PRIMARY_ENDPOINT",
    "BACKUP_WORKER_COPY_PRIMARY_REGION",
    "BACKUP_WORKER_COPY_PRIMARY_ACCESS_KEY_ID",
    "BACKUP_WORKER_COPY_PRIMARY_SECRET_ACCESS_KEY",
)

MYSQLDUMP_REQUIRED_LINE = "8.0"
_ENV_LINE = re.compile(r"\A([A-Za-z_][A-Za-z0-9_]*)=(.*)\Z")


class InstallError(Exception):
    """A step could not complete safely; main() reports it and exits 1."""


@dataclasses.dataclass(frozen=True)
class Paths:
    releases_dir: pathlib.Path = pathlib.Path("/opt/branchleft/backup-worker/releases")
    current_link: pathlib.Path = pathlib.Path("/opt/branchleft/backup-worker/current")
    unit_dir: pathlib.Path = pathlib.Path("/etc/systemd/system")
    env_file: pathlib.Path = pathlib.Path("/etc/branchleft/backup-worker.env")
    tenants_file: pathlib.Path = pathlib.Path("/etc/branchleft/backup-worker-tenants")


Runner = Callable[..., subprocess.CompletedProcess]


def release_root_of(script: pathlib.Path) -> pathlib.Path:
    """control/provision/<this file> -> the release root."""
    return script.resolve().parents[2]


def check_release(release_root: pathlib.Path, paths: Paths, *, owner_uid: int = 0) -> None:
    """Refuses a release that is not a direct child of the releases
    directory, is missing a file the loop needs, or holds a file anyone but
    `owner_uid` could rewrite: the service account runs this code."""
    if release_root.parent != paths.releases_dir.resolve():
        raise InstallError(
            f"{release_root} is not a release under {paths.releases_dir} -- stage the release "
            "there and run this script from inside it"
        )
    missing = [name for name in REQUIRED_RELEASE_FILES if not (release_root / name).is_file()]
    if missing:
        raise InstallError(f"release {release_root} is missing {', '.join(missing)}")
    for directory, subdirs, files in os.walk(release_root):
        for name in [*subdirs, *files]:
            entry = pathlib.Path(directory) / name
            info = entry.lstat()
            if info.st_uid != owner_uid or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                raise InstallError(
                    f"{entry} is writable by someone other than uid {owner_uid} -- the service "
                    "account runs this code, so it must not be able to change it"
                )


def ensure_service_user(run: Runner) -> bool:
    """Creates the system account if absent. True when it was created."""
    if run(["id", "-u", SERVICE_USER], capture_output=True, check=False).returncode == 0:
        return False
    run(
        ["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", SERVICE_USER],
        check=True,
    )
    return True


def install_units(release_root: pathlib.Path, unit_dir: pathlib.Path) -> bool:
    """Copies both unit files into place when their bytes differ. True when
    any changed, so the caller knows to daemon-reload."""
    changed = False
    for name in UNIT_FILES:
        source = (release_root / "control" / "provision" / name).read_bytes()
        target = unit_dir / name
        if target.is_file() and not target.is_symlink() and target.read_bytes() == source:
            continue
        fd, tmp_name = tempfile.mkstemp(dir=str(unit_dir), prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(source)
            os.chmod(tmp_name, 0o644)
            os.replace(tmp_name, target)
        except BaseException:
            pathlib.Path(tmp_name).unlink(missing_ok=True)
            raise
        changed = True
    return changed


def point_current_at(release_root: pathlib.Path, link: pathlib.Path) -> bool:
    """Atomically repoints `current` at this release. True when it moved."""
    if link.is_symlink() and pathlib.Path(os.readlink(link)) == release_root:
        return False
    if link.exists() and not link.is_symlink():
        raise InstallError(f"{link} exists and is not a symlink -- refusing to replace it")
    tmp_link = link.with_name(f".{link.name}.{os.getpid()}.tmp")
    tmp_link.unlink(missing_ok=True)
    os.symlink(release_root, tmp_link)
    try:
        os.replace(tmp_link, link)
    except BaseException:
        tmp_link.unlink(missing_ok=True)
        raise
    return True


def _open_root_file(path: pathlib.Path) -> tuple[os.stat_result, bytes]:
    """Reads a config file without following a symlink, and returns the
    stat of exactly what was read."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(f"{path} is not a regular file")
        chunks = []
        while chunk := os.read(fd, 65536):
            chunks.append(chunk)
        return info, b"".join(chunks)
    finally:
        os.close(fd)


def env_file_problems(path: pathlib.Path, *, owner_uid: int = 0) -> tuple[list[str], dict[str, str]]:
    """Problems with the environment file, naming keys only, never values.
    Also returns the non-secret CA path for the caller's own check."""
    try:
        info, raw = _open_root_file(path)
    except FileNotFoundError:
        return [f"{path} does not exist"], {}
    except OSError as exc:
        return [f"{path} cannot be read safely: {exc}"], {}
    problems = []
    if info.st_uid != owner_uid:
        problems.append(f"{path} must be owned by uid {owner_uid}")
    if info.st_mode & 0o077:
        problems.append(f"{path} must be mode 0600 -- it holds credentials")
    values: dict[str, str] = {}
    for line in raw.decode("utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _ENV_LINE.match(stripped)
        if match:
            values[match.group(1)] = match.group(2)
    for name in REQUIRED_ENV_NAMES:
        if not values.get(name):
            problems.append(f"{path} does not set {name}")
    ca = values.get("BACKUP_WORKER_MYSQL_SSL_CA", "")
    return problems, ({"ca": ca} if ca else {})


def ca_problems(ca_path: str) -> list[str]:
    path = pathlib.Path(ca_path)
    if not path.is_absolute():
        return [f"BACKUP_WORKER_MYSQL_SSL_CA must be an absolute path, got {ca_path!r}"]
    try:
        info = path.stat()
    except OSError:
        return [f"the database CA {ca_path} does not exist"]
    if not stat.S_ISREG(info.st_mode) or not info.st_mode & stat.S_IROTH:
        return [f"the database CA {ca_path} must be a world-readable regular file"]
    return []


def tenants_file_problems(path: pathlib.Path, *, owner_uid: int = 0, group_gid: int | None) -> list[str]:
    """The file names which tenants are dumped, so only root may change it,
    and the service account must be able to read it."""
    try:
        info, raw = _open_root_file(path)
    except FileNotFoundError:
        return [f"{path} does not exist"]
    except OSError as exc:
        return [f"{path} cannot be read safely: {exc}"]
    problems = []
    if info.st_uid != owner_uid:
        problems.append(f"{path} must be owned by uid {owner_uid}")
    if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        problems.append(f"{path} must not be writable by group or others")
    readable = info.st_mode & stat.S_IROTH or (
        group_gid is not None and info.st_gid == group_gid and info.st_mode & stat.S_IRGRP
    )
    if not readable:
        problems.append(f"{path} must be readable by the {SERVICE_USER} group (mode 0640, group {SERVICE_USER})")
    names = [
        line.strip()
        for line in raw.decode("utf-8", errors="replace").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if not names:
        problems.append(f"{path} names no tenant")
    if len(set(names)) > 1:
        problems.append(
            f"{path} names {len(set(names))} tenants, but the loop encrypts every tenant to one "
            "AGE_RECIPIENT_PUBLIC_KEY; each tenant needs its own recipient first"
        )
    return problems


def tool_problems(run: Runner, which: Callable[[str], str | None] = shutil.which) -> list[str]:
    problems = [f"{tool} is not installed" for tool in ("age", "mysqldump") if which(tool) is None]
    if which("mysqldump") is not None:
        result = run(["mysqldump", "--version"], capture_output=True, text=True, check=False)
        if f"Ver {MYSQLDUMP_REQUIRED_LINE}." not in (result.stdout or ""):
            problems.append(
                f"mysqldump is not the {MYSQLDUMP_REQUIRED_LINE} client line the database server needs"
            )
    return problems


def readiness_problems(
    paths: Paths,
    run: Runner,
    *,
    group_gid: int | None,
    owner_uid: int = 0,
    which: Callable[[str], str | None] = shutil.which,
) -> list[str]:
    problems, extra = env_file_problems(paths.env_file, owner_uid=owner_uid)
    if "ca" in extra:
        problems += ca_problems(extra["ca"])
    problems += tenants_file_problems(paths.tenants_file, owner_uid=owner_uid, group_gid=group_gid)
    problems += tool_problems(run, which)
    return problems


def _service_gid() -> int | None:
    try:
        return grp.getgrnam(SERVICE_USER).gr_gid
    except KeyError:
        try:
            return pwd.getpwnam(SERVICE_USER).pw_gid
        except KeyError:
            return None


def install(
    release_root: pathlib.Path,
    paths: Paths,
    run: Runner,
    *,
    owner_uid: int = 0,
    group_gid: Callable[[], int | None] = lambda: _service_gid(),
    which: Callable[[str], str | None] = shutil.which,
) -> list[str]:
    """Every non-secret step, then the timer only if nothing is missing.
    Returns what is still missing; empty means the timer is enabled."""
    check_release(release_root, paths, owner_uid=owner_uid)
    ensure_service_user(run)
    moved = point_current_at(release_root, paths.current_link)
    if install_units(release_root, paths.unit_dir):
        run(["systemctl", "daemon-reload"], check=True)
    problems = readiness_problems(paths, run, group_gid=group_gid(), owner_uid=owner_uid, which=which)
    if problems:
        return problems
    run(["systemctl", "enable", "--now", TIMER_UNIT], check=True)
    if moved:
        print(f"install_backup_worker: current -> {release_root}")
    return []


def main(argv: Sequence[str] | None = None, *, run: Runner = subprocess.run, paths: Paths | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="report what is still missing before the timer can be enabled; change nothing",
    )
    args = parser.parse_args(argv)
    paths = paths or Paths()

    if args.check:
        problems = readiness_problems(paths, run, group_gid=_service_gid())
    else:
        if os.geteuid() != 0:
            print("install_backup_worker: must run as root", file=sys.stderr)
            return 1
        try:
            problems = install(release_root_of(pathlib.Path(__file__)), paths, run)
        except (InstallError, OSError, subprocess.CalledProcessError) as exc:
            print(f"install_backup_worker: {exc}", file=sys.stderr)
            return 1

    if problems:
        for problem in problems:
            print(f"install_backup_worker: missing: {problem}", file=sys.stderr)
        print(f"install_backup_worker: {TIMER_UNIT} NOT enabled", file=sys.stderr)
        return 2
    print("install_backup_worker: ready" + ("" if args.check else f"; {TIMER_UNIT} enabled"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

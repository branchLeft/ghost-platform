#!/usr/bin/env python3
"""Backs up the control host's Nextcloud stack and proves it restores, by counts
only. Exit 0 proven, 1 a check failed, 2 a precondition is missing. Commands,
controls and what is never printed: nextcloud_backup.md.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import errno
import fcntl
import gzip
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass

DEFAULT_PROJECT = "nextcloud1"
DEFAULT_DB_SERVICE = "db"
DEFAULT_APP_VOLUME = "nextcloud-app"
DEFAULT_DB_USER = "nextcloud"
DEFAULT_DB_NAME = "nextcloud"
DEFAULT_TABLE_PREFIX = "oc_"
DEFAULT_BACKUP_ROOT = pathlib.Path("/var/backups/branchleft/nextcloud")
DEFAULT_LOCK_DIR = pathlib.Path("/etc/branchleft")
DEFAULT_KEEP = 3
DEFAULT_RESTORE_MEMORY = "384m"
DEFAULT_ARCHIVE_MEMORY = "128m"
HEADROOM_BYTES = 1024 * 1024 * 1024
READY_TIMEOUT_SECONDS = 90.0

LABEL = "branchleft.nextcloud-backup"
NO_LOGS = ("--log-driver", "none")
STOP_ON_ERROR = ("-v", "ON_ERROR_STOP=1")
BACKUP_NAME = re.compile(r"\A\d{8}T\d{6}Z\Z")
TABLE_PREFIX = re.compile(r"\A[a-z][a-z0-9_]{0,15}\Z")
COUNT_LINE = re.compile(r"\A(\d+)\|(\d+)\Z")
DB_FILE = "db.sql.gz"
APP_FILE = "app.tar.gz"
MANIFEST_FILE = "manifest.json"
MANIFEST_VERSION = 1
# Paths a restored Nextcloud cannot start without; checked by presence only.
APP_REQUIRED_ENTRIES = ("./config/config.php", "./data")

EXIT_OK = 0
EXIT_CHECK_FAILED = 1
EXIT_PRECONDITION = 2


class CheckFailed(Exception):
    """A backup exists but does not prove out: exit 1."""


class Precondition(Exception):
    """Something needed before anything can be proven is missing: exit 2."""


Runner = Callable[..., "subprocess.CompletedProcess[str]"]


def _run(argv: Sequence[str], **kwargs) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(list(argv), capture_output=True, text=True, check=False, **kwargs)


@dataclass(frozen=True)
class Stack:
    project: str = DEFAULT_PROJECT
    db_service: str = DEFAULT_DB_SERVICE
    app_volume: str = DEFAULT_APP_VOLUME
    db_user: str = DEFAULT_DB_USER
    db_name: str = DEFAULT_DB_NAME
    table_prefix: str = DEFAULT_TABLE_PREFIX

    def count_sql(self) -> str:
        if not TABLE_PREFIX.match(self.table_prefix):
            raise Precondition(f"table prefix {self.table_prefix!r} is not a plain identifier prefix")
        p = self.table_prefix
        return f"SELECT (SELECT count(*) FROM {p}calendars), (SELECT count(*) FROM {p}calendarobjects)"


@dataclass(frozen=True)
class Counts:
    calendars: int
    calendar_objects: int

    def as_dict(self) -> dict[str, int]:
        return {"calendars": self.calendars, "calendar_objects": self.calendar_objects}


def parse_counts(stdout: str) -> Counts:
    """The count query's only output is two integers; anything else is refused
    rather than echoed, because an unexpected line could be row data."""
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    match = COUNT_LINE.match(lines[0]) if len(lines) == 1 else None
    if not match:
        raise CheckFailed("the count query did not return exactly two integers (output withheld)")
    return Counts(int(match.group(1)), int(match.group(2)))


def compare_counts(live: Counts, restored: Counts) -> None:
    """Live against restored. A live count of zero calendars is refused too: a
    restore of nothing would match it, and this host's owner keeps a calendar."""
    if live.calendars <= 0:
        raise CheckFailed("the live count recorded 0 calendars, so equal counts would prove nothing")
    if live != restored:
        raise CheckFailed(
            "count mismatch: live calendars=%d calendar_objects=%d, restored calendars=%d calendar_objects=%d"
            % (live.calendars, live.calendar_objects, restored.calendars, restored.calendar_objects)
        )


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _docker(runner: Runner, argv: Sequence[str], what: str, **kwargs) -> str:
    result = runner(["docker", *argv], **kwargs)
    if result.returncode != 0:
        # stderr is withheld: a failing psql or tar can quote row data or paths.
        raise CheckFailed(f"{what} failed (docker exit {result.returncode}; output withheld)")
    return result.stdout


def _single(ids: str, what: str) -> str:
    found = ids.split()
    if len(found) != 1:
        raise Precondition(f"expected exactly one {what}, found {len(found)}")
    return found[0]


def find_db_container(runner: Runner, stack: Stack) -> str:
    out = _docker(
        runner,
        ["ps", "-q", "--filter", f"label=com.docker.compose.project={stack.project}",
         "--filter", f"label=com.docker.compose.service={stack.db_service}"],
        "listing the database container",
    )
    return _single(out, f"running {stack.db_service!r} container in project {stack.project!r}")


def find_app_volume(runner: Runner, stack: Stack) -> str:
    out = _docker(
        runner,
        ["volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={stack.project}",
         "--filter", f"label=com.docker.compose.volume={stack.app_volume}"],
        "listing the app volume",
    )
    if not out.split():
        # A volume created before Compose labelled volumes carries only its name.
        named = f"{stack.project}_{stack.app_volume}"
        if runner(["docker", "volume", "inspect", named]).returncode == 0:
            return named
    return _single(out, f"{stack.app_volume!r} volume in project {stack.project!r}")


def container_image(runner: Runner, container: str) -> str:
    image = _docker(runner, ["inspect", "--format", "{{.Image}}", container], "reading the database image").strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise Precondition("the database container's image id is not a sha256 digest")
    return image


def live_counts(runner: Runner, stack: Stack, container: str) -> Counts:
    out = _docker(
        runner,
        ["exec", container, "psql", "-X", "-q", "-U", stack.db_user, "-d", stack.db_name,
         *STOP_ON_ERROR, "-tA", "-c", stack.count_sql()],
        "counting the live calendars",
    )
    return parse_counts(out)


def live_db_bytes(runner: Runner, stack: Stack, container: str) -> int:
    out = _docker(
        runner,
        ["exec", container, "psql", "-X", "-q", "-U", stack.db_user, "-d", stack.db_name, "-tA",
         "-c", "SELECT pg_database_size(current_database())"],
        "sizing the live database",
    ).strip()
    if not out.isdigit():
        raise Precondition("the database size query did not return an integer")
    return int(out)


def volume_kib(runner: Runner, image: str, volume: str) -> int:
    out = _docker(
        runner,
        ["run", "--rm", *NO_LOGS, "--network", "none", "--label", f"{LABEL}=archive",
         "--memory", DEFAULT_ARCHIVE_MEMORY, "-v", f"{volume}:/volume:ro", "--entrypoint", "du",
         image, "-sk", "/volume"],
        "sizing the app volume",
    )
    first = out.split()[0] if out.split() else ""
    if not first.isdigit():
        raise Precondition("the app volume size did not come back as an integer")
    return int(first)


def require_free_space(root: pathlib.Path, needed: int, *, usage=shutil.disk_usage) -> None:
    """The backup lands on the same disk as the live volumes. Filling that disk
    would stop the live database writing, which is the loss this exists to
    prevent, so a take that would leave under 1 GiB free is refused."""
    free = usage(root).free
    if free - needed < HEADROOM_BYTES:
        raise Precondition(
            f"not enough free space at {root}: {free} bytes free, about {needed} needed plus {HEADROOM_BYTES} headroom"
        )


@contextlib.contextmanager
def deploy_lock(lock_dir: pathlib.Path, project: str) -> Iterator[None]:
    """Holds the same flock the host's deploy tool takes for this stack, so a
    backup never runs during a deploy of it, and no deploy starts mid-backup."""
    path = lock_dir / f"{project}.deploy.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
                raise Precondition(f"{path} is held: a deploy of {project} is running; try again after it") from exc
            raise
        yield
    finally:
        os.close(fd)


def _now_name(now: datetime.datetime | None = None) -> str:
    return (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y%m%dT%H%M%SZ")


def dump_database(runner_popen, stack: Stack, container: str, dest: pathlib.Path) -> None:
    argv = ["docker", "exec", container, "pg_dump", "--no-owner", "--no-acl", "-U", stack.db_user, stack.db_name]
    with gzip.open(dest, "wb") as out:
        proc = runner_popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        assert proc.stdout is not None
        for block in iter(lambda: proc.stdout.read(1 << 20), b""):
            out.write(block)
        proc.stdout.close()
        code = proc.wait()
    if code != 0:
        raise CheckFailed(f"pg_dump failed (exit {code}; output withheld)")


def archive_volume(runner: Runner, image: str, volume: str, dest_dir: pathlib.Path) -> int:
    """Archives the app volume read-only from a throwaway container. Returns the
    live entry count taken in the same container, just before the archive."""
    script = f"find /volume | wc -l && tar czf /backup/{APP_FILE} -C /volume ."
    out = _docker(
        runner,
        ["run", "--rm", *NO_LOGS, "--network", "none", "--label", f"{LABEL}=archive",
         "--memory", DEFAULT_ARCHIVE_MEMORY, "-v", f"{volume}:/volume:ro", "-v", f"{dest_dir}:/backup",
         "--entrypoint", "sh", image, "-c", script],
        "archiving the app volume",
    ).split()
    if len(out) != 1 or not out[0].isdigit():
        raise CheckFailed("the app volume entry count did not come back as an integer")
    return int(out[0])


def write_manifest(dest_dir: pathlib.Path, manifest: dict) -> None:
    path = dest_dir / MANIFEST_FILE
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")


def take(
    *, stack: Stack, root: pathlib.Path, runner: Runner = _run, popen=subprocess.Popen,
    usage=shutil.disk_usage, now: datetime.datetime | None = None, say=print,
) -> pathlib.Path:
    container = find_db_container(runner, stack)
    volume = find_app_volume(runner, stack)
    image = container_image(runner, container)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    needed = 2 * (live_db_bytes(runner, stack, container) + 1024 * volume_kib(runner, image, volume))
    require_free_space(root, needed, usage=usage)

    dest = root / _now_name(now)
    dest.mkdir(mode=0o700)
    try:
        before = live_counts(runner, stack, container)
        dump_database(popen, stack, container, dest / DB_FILE)
        after = live_counts(runner, stack, container)
        if before != after:
            raise CheckFailed("the live counts changed while the dump ran, so they are not pinned; run it again")
        entries = archive_volume(runner, image, volume, dest)
    except BaseException:
        # A half-written copy must never be mistaken for a backup later.
        shutil.rmtree(dest, ignore_errors=True)
        raise
    manifest = {
        "version": MANIFEST_VERSION,
        "taken_at": dest.name,
        "project": stack.project,
        "image": image,
        "table_prefix": stack.table_prefix,
        "db_user": stack.db_user,
        "db_name": stack.db_name,
        "counts": before.as_dict(),
        "app_entries": entries,
        "sha256": {DB_FILE: sha256_file(dest / DB_FILE), APP_FILE: sha256_file(dest / APP_FILE)},
    }
    write_manifest(dest, manifest)
    say(f"took {dest}: calendars={before.calendars} calendar_objects={before.calendar_objects} app_entries={entries}")
    return dest


def load_manifest(backup: pathlib.Path) -> dict:
    try:
        manifest = json.loads((backup / MANIFEST_FILE).read_text())
    except FileNotFoundError as exc:
        raise CheckFailed(f"{backup} has no {MANIFEST_FILE}") from exc
    except ValueError as exc:
        raise CheckFailed(f"{backup / MANIFEST_FILE} is not valid JSON") from exc
    if manifest.get("version") != MANIFEST_VERSION:
        raise CheckFailed(f"{MANIFEST_FILE} version is not {MANIFEST_VERSION}")
    return manifest


def check_digests(backup: pathlib.Path, manifest: dict) -> None:
    recorded = manifest.get("sha256") or {}
    for name in (DB_FILE, APP_FILE):
        path = backup / name
        if not path.is_file():
            raise CheckFailed(f"{path} is missing")
        if sha256_file(path) != recorded.get(name):
            raise CheckFailed(f"{path} does not match the digest recorded when it was taken")


def check_app_archive(path: pathlib.Path, expected_entries: int) -> None:
    """Reads every member to the end, which checks the gzip CRC, then compares
    the entry count. Member names are compared, never printed."""
    seen = 0
    required = set(APP_REQUIRED_ENTRIES)
    try:
        with tarfile.open(path, mode="r|gz") as archive:
            for member in archive:
                seen += 1
                required.discard(member.name.rstrip("/"))
                if member.isfile():
                    handle = archive.extractfile(member)
                    if handle is not None:
                        _drain(handle)
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise CheckFailed(f"{path} does not read to the end ({type(exc).__name__})") from exc
    if required:
        raise CheckFailed(f"{path} lacks {len(required)} of the paths a restored Nextcloud needs")
    if seen != expected_entries:
        raise CheckFailed(f"app archive entry mismatch: live {expected_entries}, archived {seen}")


def _drain(handle) -> None:
    for _ in iter(lambda: handle.read(1 << 20), b""):
        continue


@dataclass
class Throwaway:
    """One throwaway PostgreSQL with no network and no logs, removed with its
    anonymous volume however the check ends."""

    runner: Runner
    image: str
    memory: str = DEFAULT_RESTORE_MEMORY
    name: str = ""

    def __enter__(self) -> "Throwaway":
        self.name = f"nextcloud-restore-check-{secrets.token_hex(4)}"
        password = secrets.token_hex(16)
        _docker(
            self.runner,
            ["run", "-d", "--rm", "--name", self.name, *NO_LOGS, "--network", "none", "--label", f"{LABEL}=restore",
             "--memory", self.memory, "-e", "POSTGRES_PASSWORD", "-e", f"POSTGRES_USER={DEFAULT_DB_USER}",
             "-e", f"POSTGRES_DB={DEFAULT_DB_NAME}", self.image],
            "starting the throwaway database",
            env={**os.environ, "POSTGRES_PASSWORD": password},
        )
        return self

    def __exit__(self, *exc) -> None:
        self.runner(["docker", "rm", "-f", "-v", self.name])

    def wait_ready(self, *, timeout: float = READY_TIMEOUT_SECONDS, sleep=time.sleep, clock=time.monotonic) -> None:
        # TCP, not the socket: the image's init server listens on the socket
        # only, so a socket probe would pass before the real server is up.
        deadline = clock() + timeout
        while clock() < deadline:
            result = self.runner(["docker", "exec", self.name, "pg_isready", "-h", "127.0.0.1", "-q"])
            if result.returncode == 0:
                return
            sleep(1.0)
        raise CheckFailed(f"the throwaway database was not ready within {int(timeout)}s")

    def load(self, dump: pathlib.Path, *, popen=subprocess.Popen) -> None:
        argv = ["docker", "exec", "-i", self.name, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", DEFAULT_DB_USER,
                "-d", DEFAULT_DB_NAME, *STOP_ON_ERROR]
        proc = popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert proc.stdin is not None
        try:
            with gzip.open(dump, "rb") as source:
                for block in iter(lambda: source.read(1 << 20), b""):
                    proc.stdin.write(block)
        except (OSError, EOFError) as exc:
            proc.kill()
            proc.wait()
            raise CheckFailed(f"{dump} does not decompress to the end ({type(exc).__name__})") from exc
        finally:
            with contextlib.suppress(BrokenPipeError):
                proc.stdin.close()
        code = proc.wait()
        if code != 0:
            raise CheckFailed(f"the restore load stopped on an error (psql exit {code}; output withheld)")

    def counts(self, stack: Stack) -> Counts:
        result = self.runner(
            ["docker", "exec", self.name, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", DEFAULT_DB_USER,
             "-d", DEFAULT_DB_NAME, *STOP_ON_ERROR, "-tA", "-c", stack.count_sql()]
        )
        if result.returncode != 0:
            raise CheckFailed("the restored database has no countable calendar tables (output withheld)")
        return parse_counts(result.stdout)


def verify(
    backup: pathlib.Path, *, runner: Runner = _run, popen=subprocess.Popen, memory: str = DEFAULT_RESTORE_MEMORY,
    sleep=time.sleep, say=print,
) -> Counts:
    manifest = load_manifest(backup)
    check_digests(backup, manifest)
    recorded = manifest.get("counts") or {}
    try:
        live = Counts(int(recorded["calendars"]), int(recorded["calendar_objects"]))
        entries = int(manifest["app_entries"])
    except (KeyError, TypeError, ValueError) as exc:
        raise CheckFailed(f"{MANIFEST_FILE} does not record the live counts") from exc
    stack = Stack(table_prefix=str(manifest.get("table_prefix", DEFAULT_TABLE_PREFIX)))
    check_app_archive(backup / APP_FILE, entries)
    with Throwaway(runner, str(manifest.get("image", "")), memory) as target:
        target.wait_ready(sleep=sleep)
        target.load(backup / DB_FILE, popen=popen)
        restored = target.counts(stack)
    compare_counts(live, restored)
    say(
        f"verified {backup}: calendars={restored.calendars} calendar_objects={restored.calendar_objects} "
        f"app_entries={entries}, live and restored equal"
    )
    return restored


def seal(
    backup: pathlib.Path, recipient_file: pathlib.Path, *, popen=subprocess.Popen, which=shutil.which, say=print
) -> pathlib.Path:
    """Encrypts a verified backup into one age file beside it, for the off-host
    copy, and writes its digest so the copy can be checked byte for byte."""
    if not (backup / MANIFEST_FILE).is_file():
        raise Precondition(f"{backup} is not a backup this script took")
    if which("age") is None:
        raise Precondition("age is not installed on this host")
    if not recipient_file.is_file():
        raise Precondition(f"{recipient_file} does not exist")
    out = backup.parent / f"{backup.name}.tar.age"
    if out.exists():
        raise Precondition(f"{out} already exists")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        archive = popen(
            ["tar", "cf", "-", "-C", str(backup.parent), backup.name],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        encrypt = popen(
            ["age", "-R", str(recipient_file)], stdin=archive.stdout, stdout=handle, stderr=subprocess.DEVNULL
        )
        if archive.stdout is not None:
            archive.stdout.close()
        codes = (archive.wait(), encrypt.wait())
    if codes != (0, 0):
        out.unlink(missing_ok=True)
        raise CheckFailed("sealing failed (output withheld)")
    digest = sha256_file(out)
    (backup.parent / f"{out.name}.sha256").write_text(f"{digest}  {out.name}\n")
    say(f"sealed {out}: sha256={digest} bytes={out.stat().st_size}")
    return out


def prune(root: pathlib.Path, keep: int, *, protect: pathlib.Path, say=print) -> list[pathlib.Path]:
    """Removes on-host copies beyond the newest `keep`, never the one just
    verified, and only directories this script names."""
    if keep < 1:
        raise Precondition("--keep must be at least 1")
    names = sorted((p for p in root.iterdir() if p.is_dir() and BACKUP_NAME.match(p.name)), reverse=True)
    removed = []
    for old in names[keep:]:
        if old.resolve() == protect.resolve():
            continue
        shutil.rmtree(old)
        for sidecar in (root / f"{old.name}.tar.age", root / f"{old.name}.tar.age.sha256"):
            sidecar.unlink(missing_ok=True)
        removed.append(old)
    if removed:
        say(f"pruned {len(removed)} older on-host copies")
    return removed


def _stack_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--table-prefix", default=DEFAULT_TABLE_PREFIX)
    parser.add_argument("--backup-root", type=pathlib.Path, default=DEFAULT_BACKUP_ROOT)
    parser.add_argument("--lock-dir", type=pathlib.Path, default=DEFAULT_LOCK_DIR)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    _stack_args(sub.add_parser("take"))
    v = sub.add_parser("verify")
    v.add_argument("backup", type=pathlib.Path)
    v.add_argument("--restore-memory", default=DEFAULT_RESTORE_MEMORY)
    s = sub.add_parser("seal")
    s.add_argument("backup", type=pathlib.Path)
    s.add_argument("--recipient-file", type=pathlib.Path, required=True)
    r = sub.add_parser("run")
    _stack_args(r)
    r.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    r.add_argument("--restore-memory", default=DEFAULT_RESTORE_MEMORY)
    return parser


def main(argv: Sequence[str] | None = None, *, say=print) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "verify":
            verify(args.backup, memory=args.restore_memory, say=say)
        elif args.command == "seal":
            seal(args.backup, args.recipient_file, say=say)
        else:
            stack = Stack(project=args.project, table_prefix=args.table_prefix)
            stack.count_sql()
            with deploy_lock(args.lock_dir, args.project):
                taken = take(stack=stack, root=args.backup_root, say=say)
                if args.command == "run":
                    verify(taken, memory=args.restore_memory, say=say)
                    prune(args.backup_root, args.keep, protect=taken, say=say)
    except CheckFailed as exc:
        say(f"FAIL: {exc}")
        return EXIT_CHECK_FAILED
    except Precondition as exc:
        say(f"NOT RUN: {exc}")
        return EXIT_PRECONDITION
    say("OK")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""The forced-command wrapper `render_slot_sudoers.py` enumerates.

Installed at `/usr/local/sbin/branchleft-slot`, invoked only through the
sudoers rules that file generates. See branchleft_slot.md for why this
wrapper exists alongside sudoers' own enumeration, exactly what it does
and never does per invocation, and precisely what the `load` verb pins.
"""

from __future__ import annotations

import fcntl
import os
import pwd
import select
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Protocol, Sequence, Union, cast

# Mirrors `render_slot_sudoers.SLOT_NAMES` -- duplicated rather than
# imported, because this file is installed alone at
# `/usr/local/sbin/branchleft-slot` and must run with nothing else from this
# repo present on the host. `test_branchleft_slot.py`'s
# `test_slot_names_matches_the_sudoers_generators_table` is the drift guard
# that keeps the two copies equal; a table that draws them apart there fails
# a test here rather than the boundary and the wrapper silently disagreeing
# about what a legal slot is.
SLOT_NAMES: tuple[str, ...] = tuple(str(n) for n in range(7))
COLOURS: tuple[str, ...] = ("a", "b")
VERBS: tuple[str, ...] = ("start", "stop")
RESET = "reset"

# A read-only verb: `services/broker/src/app.ts`'s `attemptStopOldColour`
# needs to know whether an email or batch is still "submitting" before it
# will ever stop a colour (LLD-4 §U5), without a second privileged read
# path of the broker's own. Enumerated with the same `<slot> <colour>
# <verb>` shape as `start`/`stop` even though the query itself is
# colour-blind (`_data_directory`'s own doc comment: the colour pair
# shares one SQLite file) -- colour is accepted only so this verb's own
# argument shape matches every other enumerated invocation's. Kept
# separate from `VERBS`, never merged into it, so `main` can tell a
# privileged verb from a read-only one without inspecting strings.
READ_VERBS: tuple[str, ...] = ("email-batches",)

# Mirrors `render_slot_sudoers.BROKER_USER`/`IMAGE_STAGING_DIR`/
# `IMAGE_STAGING_FILENAME` -- duplicated for the same reason `SLOT_NAMES`
# above is: this file runs alone on the host, with nothing else from this
# repo present. `SlotNamesDriftGuardTests` in `test_branchleft_slot.py`
# guards this pair the same way it guards the slot table.
BROKER_USER = "broker"
LOAD = "load"
IMAGE_STAGING_DIR = "/var/lib/branchleft-broker/image-tmp"
IMAGE_STAGING_FILENAME = "image.tar"
IMAGE_LOAD_PATH = f"{IMAGE_STAGING_DIR}/{IMAGE_STAGING_FILENAME}"

# Root-side bounds `RealSlotOps.load_image` enforces on its own, regardless
# of whatever the broker's own `BROKER_IMAGE_MAX_BYTES`/wrapper-timeout did
# or did not catch -- a compromised broker skips its own checks, so this
# process cannot rely on them either. The byte figure matches that
# setting's own default in `services/broker/src/config.ts` (duplicated,
# not imported, for the same reason every other literal here is). It is
# checked against `st_size` at `fstat`, and `load_image` never copies more
# than that size, so a file that grows later is cut off. The timeout is
# generous for a real multi-hundred-MB image load, not tuned to any one
# measured run; `timeout` enforces it outside this process, so it holds
# even if this process is killed.
IMAGE_LOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024
IMAGE_LOAD_TIMEOUT_SECONDS = 300
IMAGE_LOAD_CHUNK_BYTES = 1024 * 1024
# Statuses `timeout --signal=KILL` leaves behind on expiry: its own 124, the
# shell's 128+9 when the group kill takes `timeout` down too, and the
# negative signal number `Popen` reports for that same death.
_IMAGE_LOAD_TIMEOUT_STATUSES = frozenset({124, 137, -9})
_IMAGE_LOAD_COMMAND = ["docker", "load"]

# Where a slot's own management state lives, and the systemd unit name
# shape LLD-2 §02 names directly ("systemctl start|stop the corresponding
# unit"). The *contents* of that unit -- what it runs to bring one colour of
# one slot's Compose stack up -- belong to the generic `branchleft-compose@`
# template `branchLeft/shared-infra`'s `hetzner/README.md` documents; this
# module only ever names an instance of it, never defines it.
SLOT_DIR = "/opt/branchleft/demo-{slot}"
ETC_DIR = "/etc/branchleft"
LOCK_DIR = "/run/branchleft"
UNIT_TEMPLATE = "branchleft-compose@demo-{slot}-{colour}"

# Docker's own default local-volume-driver layout -- read directly off the
# filesystem, never through the Docker socket or CLI (this module "never
# touches the Docker socket", per its own module docstring: holding it is
# root with no gradation). Assumes the demo host's Docker daemon uses its
# built-in "local" driver with no custom `data-root`; a host build that
# changes either would need to update this constant to match.
DOCKER_VOLUME_ROOT = Path("/var/lib/docker/volumes")

# Mirrors `services/broker/src/config.ts`'s own `BROKER_UID_BASE` default.
# Duplicated rather than imported -- this file is installed alone at
# `/usr/local/sbin/branchleft-slot` and must run with nothing else from
# this repo present on the host (the same reason `SLOT_NAMES` above is
# duplicated, not imported, from `render_slot_sudoers.py`) -- and covered
# by this module's own test asserting the two stay equal.
UID_BASE = 30001


class EmailBatchCheckError(RuntimeError):
    """Raised for anything that stops the `email-batches` count from being
    trustworthy. `main` turns every one of these into a refusal -- never a
    guessed count."""


def _data_directory(slot: str) -> Path:
    """The one, slot-derived path to the colour pair's shared SQLite data
    volume -- never a caller-supplied path, and colour-blind on purpose.
    See branchleft_slot.md#_data_directory for the mirrored constant this
    depends on and why one file is shared across both colours.
    """
    uid = UID_BASE + int(slot)
    return DOCKER_VOLUME_ROOT / f"ghost-demo-{uid}-data" / "_data"


# The one query this module ever runs for `email-batches`, a literal
# string -- `slot` selects which SQLite file to open, never anything
# interpolated into the SQL text itself.
_SUBMITTING_COUNT_QUERY = "SELECT COUNT(*) FROM email_batches WHERE status = 'submitting'"

# The wall-clock bound `count_submitting_email_batches` enforces on its own
# privileged child (see `_read_submitting_count_as_uid`) -- a hard kill from
# the still-root parent, not a hope that `O_NONBLOCK` alone rules out every
# way an open() or a query could wedge.
_READ_TIMEOUT_SECONDS = 5.0


def _validated_db_path(slot: str) -> Path:
    """Selects the slot's one candidate `*.db` name -- by name only, never
    resolved and never opened here. A symlink or a FIFO matching the
    pattern is still exactly one candidate at this point; the security
    checks happen once it is actually opened (`_open_slot_db_no_follow`),
    never here, so this function alone cannot be the thing that decides a
    malicious entry is safe.
    """
    data_dir = _data_directory(slot)
    if not data_dir.is_dir():
        raise EmailBatchCheckError(f'slot "{slot}"\'s data directory does not exist: {data_dir}')

    candidates = sorted(data_dir.glob("*.db"))
    if len(candidates) != 1:
        raise EmailBatchCheckError(
            f'slot "{slot}"\'s data directory has {len(candidates)} "*.db" files '
            f"(expected exactly one): {data_dir}"
        )
    return candidates[0]


def _open_slot_db_no_follow(path: Path, expected_uid: int) -> int:
    """Opens `path` read-only, refusing anything but a plain regular file
    owned by `expected_uid` -- and never the file a second lookup might
    resolve to. A first-open pre-screen only, not a binding guarantee for
    the sqlite open that follows; the privilege drop is what actually
    holds the boundary. See
    branchleft_slot.md#_open_slot_db_no_follow for the full reasoning.

    Returns an open fd the caller owns and must close.
    """
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        raise EmailBatchCheckError(f"failed to open {path}: {exc}") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise EmailBatchCheckError(
                f"{path} is not a regular file -- refusing to read it (st_mode={oct(st.st_mode)})"
            )
        if st.st_uid != expected_uid:
            raise EmailBatchCheckError(
                f"{path} is owned by uid {st.st_uid}, expected the slot's own uid {expected_uid} "
                "-- refusing to read a file the slot does not own"
            )
    except EmailBatchCheckError:
        os.close(fd)
        raise
    return fd


def _count_submitting_from_fd(fd: int, path_for_errors: Path) -> int:
    """Runs `_SUBMITTING_COUNT_QUERY` via `fd`'s own `/dev/fd/<n>` path --
    not a guarantee that sqlite reads exactly the descriptor
    `_open_slot_db_no_follow` already validated, since sqlite's own unix
    VFS canonicalises that path back to a name and reopens it. See
    branchleft_slot.md#_count_submitting_from_fd for why a rename raced
    against this call can still change what sqlite reads.
    """
    uri = f"file:/dev/fd/{fd}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=5)
    except (sqlite3.Error, OSError, ValueError) as exc:
        raise EmailBatchCheckError(f"failed to open {path_for_errors} read-only: {exc}") from exc
    try:
        row = connection.execute(_SUBMITTING_COUNT_QUERY).fetchone()
    except sqlite3.Error as exc:
        raise EmailBatchCheckError(
            f"the submitting-count query failed against {path_for_errors}: {exc}"
        ) from exc
    finally:
        connection.close()

    if row is None or len(row) != 1 or not isinstance(row[0], int) or row[0] < 0:
        raise EmailBatchCheckError(f"the submitting-count query returned an unexpected row: {row!r}")
    return row[0]


def _read_submitting_count(slot: str, expected_uid: int) -> int:
    """The core, privilege-agnostic check: select the one candidate path by
    name, open it refusing anything but a regular file owned by
    `expected_uid`, then run the one fixed count query. Safe to call
    directly only when the caller already runs as `expected_uid`; see
    branchleft_slot.md#_read_submitting_count for why the privilege-dropped
    caller is what actually keeps a race confined to the slot's own rights.
    """
    path = _validated_db_path(slot)
    fd = _open_slot_db_no_follow(path, expected_uid)
    try:
        return _count_submitting_from_fd(fd, path)
    finally:
        os.close(fd)


def _read_submitting_count_as_uid(slot: str, uid: int) -> int:
    """Runs `_read_submitting_count` in a forked child that has dropped to
    `uid`/`gid` before touching anything the tenant's container wrote --
    the binding control, not `_open_slot_db_no_follow`'s own checks. The
    still-privileged parent enforces `_READ_TIMEOUT_SECONDS` and verifies
    the child's reported uid before trusting its count. See
    branchleft_slot.md#_read_submitting_count_as_uid for the full
    reasoning.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            count = _read_submitting_count(slot, uid)
            os.write(write_fd, f"OK {count} {os.getuid()}".encode())
        except Exception as exc:  # noqa: BLE001 -- reported to the parent, never raised here
            os.write(write_fd, f"ERR {exc}".encode())
        finally:
            os.close(write_fd)
        os._exit(0)

    os.close(write_fd)
    timed_out = False
    chunks: list[bytes] = []
    deadline = time.monotonic() + _READ_TIMEOUT_SECONDS
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            ready, _, _ = select.select([read_fd], [], [], remaining)
            if not ready:
                continue
            chunk = os.read(read_fd, 4096)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(read_fd)
        if timed_out:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.waitpid(pid, 0)

    if timed_out:
        raise EmailBatchCheckError(
            f'slot "{slot}"\'s privileged read timed out after {_READ_TIMEOUT_SECONDS}s'
        )

    result = b"".join(chunks).decode(errors="replace")
    if result.startswith("OK "):
        try:
            count_text, reported_uid_text = result[3:].rsplit(" ", 1)
            count, reported_uid = int(count_text), int(reported_uid_text)
        except ValueError as exc:
            raise EmailBatchCheckError(f"child reported malformed success output: {result!r}") from exc
        if reported_uid != uid:
            raise EmailBatchCheckError(
                f'slot "{slot}"\'s privileged child reported running as uid {reported_uid}, '
                f"expected {uid} -- refusing to trust a count read at the wrong privilege"
            )
        return count

    message = result[4:] if result.startswith("ERR ") else result
    raise EmailBatchCheckError(f'slot "{slot}"\'s privileged read failed: {message}')


def count_submitting_email_batches(slot: str) -> int:
    """`_read_submitting_count`, run as the slot's own uid/gid
    (`UID_BASE + int(slot)`) rather than as root whenever this process
    started as root (production, via sudo) -- see
    `_read_submitting_count_as_uid`'s own doc comment for the fork, the
    privilege drop and the uid the parent verifies back. Runs directly,
    with no fork, when this process is not already root: there is no
    privilege to drop, and every test in this module exercises this
    branch, since a test process is never root.
    """
    uid = UID_BASE + int(slot)
    if os.getuid() != 0:
        return _read_submitting_count(slot, uid)
    return _read_submitting_count_as_uid(slot, uid)


class InvalidInvocation(ValueError):
    """Raised for anything that is not exactly one of the enumerated shapes.

    Every message names what was refused and why, but never re-describes
    the input as anything other than exactly the argv it was -- there is no
    step in this module that would let a message imply a split or a join
    happened, because none ever does.
    """


class RefusedImage(ValueError):
    """Raised by `RealSlotOps.load_image` when the file at `IMAGE_LOAD_PATH`
    fails its root-side verification at the moment this process opens it --
    a distinct failure from `InvalidInvocation`, which is about argv shape
    and never looks at the filesystem. `parse_invocation` accepting `load`
    says only that the *argument* was the one legal literal; this is what
    says the *file* behind it, right now, was not what `load` may load.
    """


@dataclass(frozen=True)
class ResetInvocation:
    slot: str


@dataclass(frozen=True)
class ColourInvocation:
    slot: str
    colour: str
    verb: str


@dataclass(frozen=True)
class LoadInvocation:
    """No fields: unlike every other invocation, `load`'s one legal argument
    is a single unchanging literal (`IMAGE_LOAD_PATH`), not a value that
    varies across calls -- there is nothing here for a field to carry.
    """


Invocation = Union[ResetInvocation, ColourInvocation, LoadInvocation]


def parse_invocation(argv: Sequence[str]) -> Invocation:
    """The one function that decides whether argv is legal.

    Checks length first, then membership of each element in its own closed
    set, always -- never `.split()`, `.join()` or any string formatting on
    argv before comparing it. See branchleft_slot.md#parse_invocation for
    why that absence is the property under test, and how the `load` verb's
    single-literal argument gets the identical scrutiny.
    """
    if len(argv) == 2:
        first, second = argv
        if first == LOAD:
            if second == IMAGE_LOAD_PATH:
                return LoadInvocation()
            raise InvalidInvocation(
                f"refused: {list(argv)!r} is not the exact two-argument load form "
                f"({LOAD!r} {IMAGE_LOAD_PATH!r})"
            )
        if first in SLOT_NAMES and second == RESET:
            return ResetInvocation(slot=first)
        raise InvalidInvocation(
            f"refused: {list(argv)!r} is not the exact two-argument reset form "
            f"(<enumerated slot> {RESET!r}) or the exact two-argument load form "
            f"({LOAD!r} {IMAGE_LOAD_PATH!r})"
        )
    if len(argv) == 3:
        slot, colour, verb = argv
        if slot in SLOT_NAMES and colour in COLOURS and verb in (*VERBS, *READ_VERBS):
            return ColourInvocation(slot=slot, colour=colour, verb=verb)
        allowed_verbs = (*VERBS, *READ_VERBS)
        raise InvalidInvocation(
            f"refused: {list(argv)!r} is not an enumerated colour invocation "
            f"(<enumerated slot> {{{'|'.join(COLOURS)}}} {{{'|'.join(allowed_verbs)}}})"
        )
    raise InvalidInvocation(
        f"refused: expected exactly 2 or 3 arguments, got {len(argv)}: {list(argv)!r} -- "
        "a single argument holding a space is not two arguments, however sudo counted it"
    )


class SlotOps(Protocol):
    def systemctl(self, action: str, unit: str) -> None: ...
    def remove_dir_contents(self, path: str) -> None: ...
    def remove_file_if_present(self, path: str) -> None: ...
    def recreate_empty_dir(self, path: str) -> None: ...
    def load_image(self, path: str) -> None: ...


def _stream_checked_bytes_into_docker_load(fd: int, expected_bytes: int) -> None:
    """Runs `docker load` under `timeout` in its own session and feeds it
    the first `expected_bytes` bytes of `fd`, then reports how it ended.

    Raises:
        RuntimeError: `fd` ended early, or docker exited 0 before reading it all.
        subprocess.TimeoutExpired: docker ran out `IMAGE_LOAD_TIMEOUT_SECONDS`.
        subprocess.CalledProcessError: docker exited non-zero.
        OSError: reading `fd` or starting the process failed.
    """
    timeout_seconds = IMAGE_LOAD_TIMEOUT_SECONDS
    started = time.monotonic()
    proc = subprocess.Popen(
        ["timeout", "--signal=KILL", str(timeout_seconds), *_IMAGE_LOAD_COMMAND],
        stdin=subprocess.PIPE,
        start_new_session=True,
    )
    stdin = cast(IO[bytes], proc.stdin)
    try:
        pipe_broke = _write_checked_bytes(proc, stdin.fileno(), fd, expected_bytes)
        if not pipe_broke:
            stdin.close()
        returncode = proc.wait()
    except BaseException:
        if proc.returncode is None:
            _kill_process_group_and_reap(proc)
        raise
    finally:
        stdin.close()
    if returncode == 0 and pipe_broke:
        raise RuntimeError("docker load exited 0 without reading the whole archive")
    _raise_for_docker_exit(returncode, time.monotonic() - started, timeout_seconds)


def _write_checked_bytes(
    proc: subprocess.Popen[bytes], stdin_fd: int, fd: int, expected_bytes: int
) -> bool:
    """Writes `expected_bytes` bytes of `fd`, read from offset 0, to the
    stdin of `proc` (`stdin_fd`). Returns whether docker closed the pipe first. A file
    that ends early kills docker's group before stdin is closed, so docker
    never sees a clean end-of-file for a truncated archive.

    Raises:
        RuntimeError: `fd` ended before `expected_bytes` bytes were read.
        OSError: reading `fd` failed.
    """
    offset = 0
    while offset < expected_bytes:
        chunk = os.pread(fd, min(IMAGE_LOAD_CHUNK_BYTES, expected_bytes - offset), offset)
        if not chunk:
            _kill_process_group_and_reap(proc)
            raise RuntimeError(
                f"image file ended after {offset} of {expected_bytes} expected bytes"
            )
        try:
            _write_all(stdin_fd, chunk)
        except BrokenPipeError:
            return True
        offset += len(chunk)
    return False


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(descriptor, view) :]


def _kill_process_group_and_reap(proc: subprocess.Popen[bytes]) -> None:
    os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()


def _raise_for_docker_exit(returncode: int, elapsed_seconds: float, timeout_seconds: int) -> None:
    """A timeout status alone is not proof of a timeout -- docker can exit
    124 itself -- so it counts only once the deadline had nearly passed.

    Raises:
        subprocess.TimeoutExpired: a timeout status after the deadline.
        subprocess.CalledProcessError: any other non-zero status.
    """
    if returncode == 0:
        return
    if returncode in _IMAGE_LOAD_TIMEOUT_STATUSES and elapsed_seconds >= timeout_seconds - 1:
        raise subprocess.TimeoutExpired(_IMAGE_LOAD_COMMAND, timeout_seconds)
    raise subprocess.CalledProcessError(returncode, _IMAGE_LOAD_COMMAND)


class RealSlotOps:
    """The only implementation this module ships with real effects. Every
    method is a thin, explicit-argv wrapper -- `subprocess.run` is never
    given `shell=True`, so there is no second shell anywhere in this
    process to reintroduce the join/split problem `parse_invocation` exists
    to avoid.
    """

    def systemctl(self, action: str, unit: str) -> None:
        subprocess.run(["systemctl", action, unit], check=True)

    def load_image(self, path: str) -> None:
        """Opens `path` (always `IMAGE_LOAD_PATH`) with `O_NOFOLLOW` and
        `O_NONBLOCK`, `fstat`s the resulting descriptor to require a
        regular, size-bounded file owned by the broker account, then reads
        exactly the `st_size` bytes recorded at that `fstat` from the
        already-open descriptor and writes them to the stdin pipe of
        `docker load`. The file may grow afterwards without effect; if it
        shrinks below `st_size`, the load fails. `docker load` runs in its
        own process group under `timeout`, so `IMAGE_LOAD_TIMEOUT_SECONDS`
        still holds if this process is killed. See
        branchleft_slot.md#realslotopsload_image for why each check exists
        and why the path is never resolved a second time.

        Raises:
            RefusedImage: the path failed a pre-load check.
            RuntimeError: the file ended before `st_size` bytes were read,
                or docker exited 0 without reading the whole archive.
            subprocess.TimeoutExpired: `docker load` ran out its deadline.
            subprocess.CalledProcessError: `docker load` exited non-zero.
            OSError: reading the file or starting `docker load` failed.
        """
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError as exc:
            raise RefusedImage(f"refused: cannot open {path!r}: {exc}") from exc
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise RefusedImage(f"refused: {path!r} is not a regular file")
            if info.st_size > IMAGE_LOAD_MAX_BYTES:
                raise RefusedImage(
                    f"refused: {path!r} is {info.st_size} bytes, over the "
                    f"{IMAGE_LOAD_MAX_BYTES}-byte limit this wrapper enforces on its own"
                )
            try:
                broker_uid = pwd.getpwnam(BROKER_USER).pw_uid
            except KeyError as exc:
                raise RefusedImage(
                    f"refused: broker account {BROKER_USER!r} does not exist on this host"
                ) from exc
            if info.st_uid != broker_uid:
                raise RefusedImage(
                    f"refused: {path!r} is owned by uid {info.st_uid}, not the "
                    f"{BROKER_USER!r} account (uid {broker_uid})"
                )
            _stream_checked_bytes_into_docker_load(fd, info.st_size)
        finally:
            os.close(fd)

    def remove_dir_contents(self, path: str) -> None:
        if not os.path.isdir(path):
            return
        for name in os.listdir(path):
            target = os.path.join(path, name)
            if os.path.islink(target) or os.path.isfile(target):
                os.remove(target)
            else:
                shutil.rmtree(target)

    def remove_file_if_present(self, path: str) -> None:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

    def recreate_empty_dir(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)


def _lock_path(slot: str) -> str:
    return os.path.join(LOCK_DIR, f"branchleft-slot-{slot}.lock")


def _acquire_slot_lock(slot: str):
    """An exclusive `flock` on a per-slot file, held for the whole of
    `perform` -- LLD-2 §02: "take an exclusive flock on the slot so two
    reconciles cannot interleave." One file per slot rather than one for
    the whole host, so two different slots' invocations never wait on each
    other for no reason.
    """
    os.makedirs(LOCK_DIR, exist_ok=True)
    handle = open(_lock_path(slot), "w")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def perform(invocation: Invocation, ops: SlotOps) -> None:
    if isinstance(invocation, LoadInvocation):
        # Not slot-scoped, so it never takes `_acquire_slot_lock` -- there is
        # no slot name to lock on, and the image being loaded is shared
        # across every slot, not owned by one of them.
        ops.load_image(IMAGE_LOAD_PATH)
        return

    lock = _acquire_slot_lock(invocation.slot)
    try:
        if isinstance(invocation, ColourInvocation):
            unit = UNIT_TEMPLATE.format(slot=invocation.slot, colour=invocation.colour)
            ops.systemctl(invocation.verb, unit)
            return

        # Reset is slot-level: stop both colours regardless of which one (if
        # either) is actually running, because a reset that left one colour
        # up would hand the next lease a live Ghost belonging to the last
        # one (LLD-2 §01b, §02).
        for colour in COLOURS:
            unit = UNIT_TEMPLATE.format(slot=invocation.slot, colour=colour)
            ops.systemctl("stop", unit)

        slot_dir = SLOT_DIR.format(slot=invocation.slot)
        ops.remove_dir_contents(slot_dir)
        for colour in COLOURS:
            ops.remove_file_if_present(
                os.path.join(ETC_DIR, f"demo-{invocation.slot}-{colour}.env")
            )
        ops.recreate_empty_dir(slot_dir)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        invocation = parse_invocation(args)
    except InvalidInvocation as exc:
        print(f"branchleft-slot: {exc}", file=sys.stderr)
        return 1

    # Read-only verbs never reach `perform`/`RealSlotOps` at all -- there is
    # no privileged side effect to take the per-slot flock around, and
    # `SlotOps.systemctl` has no meaning for a verb that is not `start` or
    # `stop`.
    if isinstance(invocation, ColourInvocation) and invocation.verb in READ_VERBS:
        try:
            count = count_submitting_email_batches(invocation.slot)
        except EmailBatchCheckError as exc:
            print(f"branchleft-slot: {exc}", file=sys.stderr)
            return 1
        print(count)
        return 0

    try:
        perform(invocation, RealSlotOps())
    except Exception as exc:  # noqa: BLE001 -- this is the process boundary; report and exit non-zero
        print(f"branchleft-slot: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

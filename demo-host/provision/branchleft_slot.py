#!/usr/bin/env python3
"""The forced-command wrapper `render_slot_sudoers.py` enumerates.

Installed at `/usr/local/sbin/branchleft-slot`, root-owned and executable,
and invoked only through the sudoers rules that file generates: `broker
ALL=(root) NOPASSWD: /usr/local/sbin/branchleft-slot <invocation>`, one
literal line per enumerated invocation.

**Why this file exists at all, given the sudoers file already enumerates
every legal invocation.** Measured against real `sudo -n`: sudo compares
the *space-joined text*
of the argv it receives against each configured command as a literal
string, not argv element by element. So `sudo branchleft-slot '0 reset'` --
one shell-quoted argument holding a space -- produces the same space-joined
text as the intended two-argument `<slot> reset` invocation and is equally
permitted by the sudoers file, but this process then receives ONE argument
(`"0 reset"`), not two. The sudoers file and this wrapper are the boundary
*together*: sudoers can only ever prove an invocation is on the list once
its arguments are already split into how many the wrapper expects, and
splitting is exactly the step sudo does not do. So `parse_invocation` below
checks argv's own length first and then each element against its own
closed set -- it is never given cause to join or re-split anything, and it
must never gain one: joining argv into a string and matching a pattern
against it is the exact defect this module exists to not have.

What this process does, and only this, per LLD-2 §02: validate that argv is
exactly the enumerated shape, take an exclusive lock on the named slot so
two reconciles cannot interleave, then start or stop the one systemd unit
that shape names -- or for `reset`, stop both of a slot's colour units and
wipe the slot's own state. It never touches the Docker socket (systemctl
is the only privileged primitive it uses -- a docker command is root with
no gradation, which is the exact erosion enumeration exists to avoid), never
accepts a path as an argument, never writes `/etc/branchleft/<slot>-<colour>.env`
(the broker writes that, unprivileged, before ever asking for a start), and
never reads or touches anything outside the one slot its argv names.

One verb, `email-batches`, is read-only rather than privileged: it takes no
lock and never calls `systemctl`, only a single fixed `COUNT` query
(`count_submitting_email_batches`) against the named slot's own SQLite
file, printing the bare count to stdout. Enumerated the same way as
`start`/`stop` (see `READ_VERBS`) because sudoers' own boundary has no
notion of "read-only" -- only "on the list" -- so it gets the identical
argv-shape scrutiny `parse_invocation` already gives every other verb.
"""

from __future__ import annotations

import fcntl
import os
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
from typing import Protocol, Sequence, Union

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
    volume -- never a caller-supplied path. Mirrors `render-core`'s
    `demoDataMount` (`render-core/src/render.ts`): the volume is named
    `ghost-demo-<uid>-data`, and `uid` is `UID_BASE + int(slot)` -- the one
    field `services/broker/src/app.ts`'s `handleReconcile` enforces must
    equal the slot's own allocation before any render happens, so it is
    safe to re-derive here from the slot literal alone.

    Colour-blind on purpose: `render-core/src/compose.ts`'s
    `composeDocument` mounts this same volume into *both* `ghost-a` and
    `ghost-b` -- one shared SQLite file per slot, not one per colour -- so
    a colour argument changes nothing about which file this opens.
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
    resolve to.

    **What this is, and what it is not.** The volume this path lives in
    is written by the tenant's own Ghost container (`render-core/src/
    compose.ts` runs it as `user: "<uid>:<uid>"`), so the *name*
    `email-batches` opens is chosen by code the tenant controls. This
    check screens the *first* open, and only the first: `O_NOFOLLOW`
    refuses a symlink outright here; `O_NONBLOCK` means opening a FIFO or
    several device types returns immediately rather than blocking (a
    documented no-op for a regular file, so it costs a correct caller
    nothing); `fstat` on the already-open descriptor -- never a second
    `stat()` on the name, which a rename could race -- proves what this
    call actually opened is a regular file owned by exactly `expected_uid`.

    **It does not bind sqlite to this exact descriptor.** `_count_
    submitting_from_fd`, below, hands sqlite this fd's own `/dev/fd/<n>`
    path rather than `path` again, which looks like it should be
    equivalent to querying the descriptor directly -- it is not: sqlite's
    own unix VFS canonicalises that path back to a name (`readlink`s
    through it) and reopens *that*, so a rename raced in between this
    check and sqlite's own open can still swap what actually gets read.
    This function is a first-open pre-screen, never sqlite's binding
    guarantee. **The privilege drop is what actually matters here**
    (`_read_submitting_count_as_uid`'s own doc comment): by the time this
    runs, the caller already has no rights beyond the slot's own uid, so
    the *worst* a won rename race achieves is a wrong count for the
    tenant's own already-owned data -- never a read of anything owned by
    another slot or by root. A FIFO or device swapped in after this check
    is still caught: sqlite's own open has no `O_NONBLOCK` of its own, so
    it can block, but `_read_submitting_count_as_uid`'s hard wall-clock
    timeout kills a wedged child regardless, fail-closed.

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
    **not a guarantee that sqlite reads exactly the descriptor
    `_open_slot_db_no_follow` already validated.** `/dev/fd/<n>` looks
    like a bound alias for the open file, but sqlite's own unix VFS
    canonicalises every path it is given, `/dev/fd/<n>` included: it
    `readlink`s through to the underlying name and reopens *that*, not
    the file descriptor number. A rename raced in between the fstat
    check and this call can therefore still change what sqlite actually
    reads. See `_open_slot_db_no_follow`'s own doc comment for why this
    is a first-open pre-screen rather than sqlite's own binding
    guarantee, and why the privilege drop -- not this function -- is
    what actually keeps the read inside the slot's own rights.
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
    `expected_uid` (`_open_slot_db_no_follow`'s own first-open pre-screen),
    then run the one fixed count query (`_count_submitting_from_fd`,
    whose own doc comment covers what that pre-screen does and does not
    bind). Safe to call directly when the caller is already running as
    `expected_uid` -- every test in this module does, since a test process
    is never root -- or from inside the privilege-dropped child
    `_read_submitting_count_as_uid` forks, below, which is what actually
    keeps a race here confined to the slot's own rights.
    """
    path = _validated_db_path(slot)
    fd = _open_slot_db_no_follow(path, expected_uid)
    try:
        return _count_submitting_from_fd(fd, path)
    finally:
        os.close(fd)


def _read_submitting_count_as_uid(slot: str, uid: int) -> int:
    """Runs `_read_submitting_count` in a forked child that has dropped to
    `uid`/`gid` *before* touching anything the tenant's container wrote --
    so root itself never opens a path the tenant chose; only a process
    with exactly the tenant's own rights does. **This drop is the binding
    control**, not `_open_slot_db_no_follow`'s own O_NOFOLLOW/fstat/owner
    checks (see that function's own doc comment for why sqlite's later
    reopen-by-name can still race past them): once privilege is dropped,
    the worst any such race can do is hand the tenant a wrong count for
    its own already-owned data, never a read of another slot's or root's.
    The still-privileged parent never drops anything itself: it enforces
    `_READ_TIMEOUT_SECONDS` as a hard wall-clock bound, killing the child
    outright on a timeout rather than trusting `O_NONBLOCK` alone to rule
    out every way this could wedge, and it never trusts the child's own
    claim of success without checking the child actually reports having
    run as `uid` -- a child that could not drop privilege (or one that
    had that call silently disabled) reports its *real* uid instead,
    which the parent catches here rather than returning a count read at
    the wrong privilege.
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


@dataclass(frozen=True)
class ResetInvocation:
    slot: str


@dataclass(frozen=True)
class ColourInvocation:
    slot: str
    colour: str
    verb: str


Invocation = Union[ResetInvocation, ColourInvocation]


def parse_invocation(argv: Sequence[str]) -> Invocation:
    """The one function that decides whether argv is legal.

    Checks length first, then membership of each element in its own closed
    set -- `argv[i] in ALLOWED_SET`, always. Nothing here calls `.split()`,
    `.join()`, `" ".join()` or any string formatting on argv itself before
    comparing it; the only formatting in this module happens *after*
    validation, when building the unit name or path from an already-checked
    slot/colour. That absence is the property under test: a caller that
    reduces argv to a string at any point before this function returns
    reproduces sudo's own defect on the second layer, in the one place that
    exists to not have it.
    """
    if len(argv) == 2:
        slot, verb = argv
        if slot in SLOT_NAMES and verb == RESET:
            return ResetInvocation(slot=slot)
        raise InvalidInvocation(
            f"refused: {list(argv)!r} is not the exact two-argument reset form "
            f"(<enumerated slot> {RESET!r})"
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


class RealSlotOps:
    """The only implementation this module ships with real effects. Every
    method is a thin, explicit-argv wrapper -- `subprocess.run` is never
    given `shell=True`, so there is no second shell anywhere in this
    process to reintroduce the join/split problem `parse_invocation` exists
    to avoid.
    """

    def systemctl(self, action: str, unit: str) -> None:
        subprocess.run(["systemctl", action, unit], check=True)

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

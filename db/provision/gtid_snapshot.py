#!/usr/bin/env python3
"""A consistent per-tenant dump taken with no lock, and the recovery position
it carries: the GTID set of exactly the transactions the dump holds.

No coordinator session, no `LOCK TABLES`, no `FLUSH`: one `mysqldump
--single-transaction --set-gtid-purged=ON` against a server (Percona Server
on the tenant database host) that reads its own GTID set atomically with the
snapshot. This module builds that command, refuses any option that would add
a lock, reads the set off the dump's header as it streams, and reports it.
Point-in-time replay starts from the set (extract_tenant_binlog.py). See
gtid_snapshot.md.
"""

from __future__ import annotations

import dataclasses
import re
import subprocess
from collections.abc import Sequence

import bounded_snapshot

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_UUID_PATTERN = re.compile(_UUID)
_INTERVAL_PATTERN = re.compile(r"^(?P<low>\d+)(?:-(?P<high>\d+))?$")

# The statement mysqldump writes for --set-gtid-purged=ON: `/*!80000 '+'*/`
# (append) is present from 8.0 and absent before; the set may run over
# several lines, broken after each comma.
_PURGED_START_PATTERN = re.compile(r"^SET @@GLOBAL\.GTID_PURGED\s*=\s*(?:/\*!\d+ '\+'\*/\s*)?'(?P<rest>.*)$")

# The first line of the dump's body. The GTID statement always precedes
# these, so anything after one is data and is never read as a position.
_BODY_START_PREFIXES = ("CREATE DATABASE", "USE `", "DROP ", "CREATE TABLE", "INSERT ", "LOCK TABLES", "ALTER ")

# A dump that can only be consistent because something held a lock, or that
# records a position another way. Each is refused by name.
_REFUSED_OPTIONS = (
    "--lock-all-tables",
    "--lock-tables",
    "--source-data",
    "--master-data",
    "--flush-logs",
    "--flush-privileges",
    "--delete-source-logs",
    "--delete-master-logs",
)
_REFUSED_SHORT_OPTIONS = frozenset({"-x", "-l", "-F"})

SNAPSHOT_OPTION = "--single-transaction"
GTID_OPTION = "--set-gtid-purged=ON"


class GtidError(Exception):
    """A GTID set or a dump's GTID statement is malformed, absent or
    ambiguous. Never a reason to guess a position."""


class NoGtidStatement(GtidError):
    """The dump's header carries no GTID_PURGED statement at all."""


# A GTID set: server uuid (lowercase) -> sorted, non-overlapping, non-adjacent
# (low, high) intervals, both ends inclusive.
GtidSet = dict[str, tuple[tuple[int, int], ...]]


def _merge(intervals: Sequence[tuple[int, int]]) -> tuple[tuple[int, int], ...]:
    merged: list[tuple[int, int]] = []
    for low, high in sorted(intervals):
        if merged and low <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], high))
        else:
            merged.append((low, high))
    return tuple(merged)


def parse_gtid_set(text: str) -> GtidSet:
    """`uuid:1-5:7,uuid:1-3`, whitespace anywhere (mysqldump breaks the
    set over lines) ignored. The empty string is the empty set: a server that
    has committed nothing. Anything else malformed raises GtidError."""
    flat = "".join(text.split())
    result: dict[str, list[tuple[int, int]]] = {}
    if not flat:
        return {}
    for part in flat.split(","):
        pieces = part.split(":")
        if len(pieces) < 2 or not _UUID_PATTERN.fullmatch(pieces[0]):
            raise GtidError(f"not a GTID set member: {part!r}")
        intervals = result.setdefault(pieces[0].lower(), [])
        for piece in pieces[1:]:
            match = _INTERVAL_PATTERN.match(piece)
            if match is None:
                raise GtidError(f"not a GTID interval: {piece!r} in {part!r}")
            low = int(match.group("low"))
            high = int(match.group("high")) if match.group("high") is not None else low
            if low < 1 or high < low:
                raise GtidError(f"not a GTID interval: {piece!r} in {part!r}")
            intervals.append((low, high))
    return {uuid: _merge(intervals) for uuid, intervals in result.items()}


def format_gtid_set(gtid_set: GtidSet) -> str:
    """The canonical one-line form: uuids sorted, intervals merged, no
    whitespace. What goes after `--exclude-gtids=`."""
    members = []
    for uuid in sorted(gtid_set):
        spans = ":".join(str(low) if low == high else f"{low}-{high}" for low, high in gtid_set[uuid])
        members.append(f"{uuid}:{spans}")
    return ",".join(members)


def normalise_gtid_set(text: str) -> str:
    return format_gtid_set(parse_gtid_set(text))


def is_subset(inner: GtidSet, outer: GtidSet) -> bool:
    """True if every transaction in `inner` is in `outer`."""
    for uuid, intervals in inner.items():
        covering = outer.get(uuid, ())
        for low, high in intervals:
            if not any(c_low <= low and high <= c_high for c_low, c_high in covering):
                return False
    return True


class PurgedStatementScanner:
    """Reads the recovery position off a dump as it streams, line by line.
    Only the header is read: the first line of the body ends the scan, so a
    row whose text looks like the statement can never forge a position. Two
    statements are refused as ambiguous."""

    def __init__(self) -> None:
        self._buffer: str | None = None
        self._position: str | None = None
        self._body_started = False

    @property
    def position(self) -> str | None:
        """The canonical GTID set, or None if the header carried no statement."""
        return self._position

    @property
    def finished(self) -> bool:
        return self._body_started

    def feed_bytes(self, raw: bytes) -> None:
        if self._body_started:
            return
        self.feed(raw.decode(errors="replace"))

    def feed(self, line: str) -> None:
        if self._body_started:
            return
        line = line.rstrip("\r\n")
        if self._buffer is not None:
            self._buffer += "\n" + line
            self._finish_if_closed()
            return
        match = _PURGED_START_PATTERN.match(line)
        if match is not None:
            if self._position is not None:
                raise GtidError("the dump carries two GTID_PURGED statements: the recovery position is ambiguous")
            self._buffer = match.group("rest")
            self._finish_if_closed()
            return
        if line.startswith(_BODY_START_PREFIXES):
            self._body_started = True

    def _finish_if_closed(self) -> None:
        assert self._buffer is not None
        stripped = self._buffer.rstrip()
        if not stripped.endswith("';"):
            return
        self._position = normalise_gtid_set(stripped[: -len("';")])
        self._buffer = None

    def require_position(self) -> str:
        """The position, or GtidError: a dump with no statement has no
        recovery position and is not a backup."""
        if self._buffer is not None:
            raise GtidError("the dump's GTID_PURGED statement never closed: the dump is cut short")
        if self._position is None:
            raise NoGtidStatement(
                "the dump carries no GTID_PURGED statement: it was not taken with --set-gtid-purged=ON "
                "against a server with gtid_mode=ON, so it has no recovery position"
            )
        return self._position


def scan_dump_position(lines) -> str:
    """The recovery position of a whole dump given as an iterable of lines."""
    scanner = PurgedStatementScanner()
    for line in lines:
        scanner.feed(line)
        if scanner.finished:
            break
    return scanner.require_position()


def dump_args(db_name: str) -> list[str]:
    """The lock-free dump for one tenant database. `--no-tablespaces`: the
    backup account holds no PROCESS."""
    return [
        SNAPSHOT_OPTION,
        "--routines",
        "--triggers",
        GTID_OPTION,
        "--no-tablespaces",
        "--databases",
        db_name,
    ]


def assert_lock_free_args(args: Sequence[str]) -> None:
    """Refuses a dump command that is not exactly the lock-free kind: it must
    be a single-transaction dump with the GTID set, and carry no option that
    locks tables, flushes, or records a file-and-position instead."""
    for arg in args:
        name = arg.split("=", 1)[0]
        if name in _REFUSED_OPTIONS or arg in _REFUSED_SHORT_OPTIONS:
            raise GtidError(f"refusing {arg!r}: it takes a lock or a flush, or records a position the GTID set replaces")
        if name == "--set-gtid-purged" and arg != GTID_OPTION:
            raise GtidError(f"refusing {arg!r}: the recovery position is the dump's GTID set, so it must be {GTID_OPTION}")
    if SNAPSHOT_OPTION not in args:
        raise GtidError(f"refusing a dump without {SNAPSHOT_OPTION}: without it the dump is not one snapshot")
    if GTID_OPTION not in args:
        raise GtidError(f"refusing a dump without {GTID_OPTION}: it would carry no recovery position")


@dataclasses.dataclass(frozen=True)
class GtidSnapshotReport:
    """What a lock-free snapshot measured. The lock fields are the same ones
    `bounded_snapshot.SnapshotReport` carries, so a caller that records them
    records zeros: nothing was locked, waited for or held."""

    recovery_gtid_set: str | None = None
    lock_wait_seconds: float = 0.0
    hold_seconds: float = 0.0
    tables_locked: int = 0
    attempts: int = 1
    aborted_attempts: int = 0

    def coordinates_comment(self) -> bytes:
        """Nothing to prepend: the position is the dump's own header."""
        return b""


def take_gtid_snapshot(
    *, factory: bounded_snapshot.ClientFactory, args: Sequence[str]
) -> bounded_snapshot.StartedDump:
    """Starts the dump. The only session opened is mysqldump's own; there is
    no coordinator, nothing to wait for and nothing to release. The caller
    streams `process.stdout` through a PurgedStatementScanner."""
    assert_lock_free_args(args)
    process = factory.spawn(
        "mysqldump",
        list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    return bounded_snapshot.StartedDump(process=process, stderr=bounded_snapshot.StderrTail(process.stderr))

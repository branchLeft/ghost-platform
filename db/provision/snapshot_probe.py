#!/usr/bin/env python3
"""The six step-0 controls for the blog move's snapshot (option (c)), run
against local throwaway containers of the pinned MySQL digest. Design,
controls and exit codes: db/provision/snapshot_probe.md. The verdict
functions are pure; test_snapshot_probe.py drives them without Docker.
Nothing here reaches a host.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import itertools
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence

_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import bounded_snapshot as bs  # noqa: E402
import extract_tenant_binlog  # noqa: E402

# Control 2: the other schema's worst statement must stay under this.
WRITER_LIMIT_SECONDS = 0.100
# Control 5: the ticket body's ceiling for a queued writer's wait, and the
# module's own (wait deadline plus hold bound). Both are asserted.
BODY_WAIT_CEILING_SECONDS = 2.0
MODULE_WAIT_BOUND_SECONDS = round(bs.WAIT_DEADLINE_SECONDS + bs.HOLD_BOUND_SECONDS, 3)
# The harness times a statement across `docker exec` pipes, here under
# emulation; this much is allowed on top of a bound, no more.
MEASUREMENT_MARGIN_SECONDS = 0.25

MOVER = "mover"
# The same grants as the move account but without BACKUP_ADMIN: seed reads
# log_status as it, to record what BACKUP_ADMIN is needed for.
NOBACKUP = "nobackup"
REPLICATION_USER = "repl"
BLOG = "blog"
OTHER = "other"

# Copied from RemoteMysqldumpTransport.dump_args in
# infra/provisioning/scripts/dial_in_transport.py, the real per-tenant path.
# test_snapshot_probe.py asserts the two stay equal.
DUMP_ARGS = (
    "--single-transaction",
    "--routines",
    "--triggers",
    "--set-gtid-purged=OFF",
    "--no-tablespaces",
    "--databases",
    BLOG,
)

# The controls 1 to 5 gate option (c); 6 is a recorded finding.
GATING_CONTROLS = (1, 2, 3, 4, 5)
SABOTAGE_TARGETS = {
    "coordinates-after-write": (1,),
    "old-path": (2, 3),
    "other-lock": (2,),
    "reload-grant": (4,),
    "no-timeout": (5,),
    "no-deadline": (5,),
}

EXIT_PASSED = 0
EXIT_RED = 1
EXIT_SABOTAGE_NOT_DETECTED = 2
EXIT_OPTION_C_UNAVAILABLE = 3
EXIT_FINDING_NOT_RECORDED = 4
# Refused before any container, as prove-snapshot-locking.sh refuses (exit 5).
EXIT_REFUSED = 5
LOCAL_DOCKER_CONTEXTS = ("default", "desktop-linux")
CONTAINER_PREFIX = "snapshot-proof-"


# --------------------------------------------------------------------------
# Pure verdicts
# --------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Verdict:
    passed: bool
    reason: str


def _ms(seconds: float) -> str:
    return f"{seconds * 1000:.1f} ms"


def indexed_between(samples: Iterable[tuple[float, float]], began: float, ended: float) -> list[tuple[int, float, float]]:
    """(statement number, start, latency) of the statements that overlap the
    window [began, ended]. The number is the 1-based position in `samples`,
    which is the number in the statement's own SQL text."""
    return [
        (number, start, latency)
        for number, (start, latency) in enumerate(samples, 1)
        if start + latency >= began and start <= ended
    ]


def latencies_between(samples: Iterable[tuple[float, float]], began: float, ended: float) -> list[float]:
    """Latencies of the statements that overlap the window [began, ended].
    A sample is (start, latency); one that started before the window and
    finished inside it counts, since that is a stall seen from inside."""
    return [latency for _, _, latency in indexed_between(samples, began, ended)]


def writer_stall_verdict(latencies: Sequence[float], limit: float, *, mechanism: str | None = None) -> Verdict:
    """Control 2, the one verdict for both probes: the client-observed
    maximum against a fixed limit. A probe that took no samples is blind, not
    clean. `mechanism` (from `StallReport`) is named in a red reason only."""
    if not latencies:
        return Verdict(False, "control 2: the writer took no samples in the window: the probe could not see a stall")
    worst = max(latencies)
    if worst > limit:
        named = f"; mechanism: {mechanism}" if mechanism else ""
        return Verdict(
            False, f"control 2: worst statement {_ms(worst)} exceeds the {_ms(limit)} limit over {len(latencies)} statements{named}"
        )
    return Verdict(True, f"control 2: worst statement {_ms(worst)} within the {_ms(limit)} limit over {len(latencies)} statements")


# --------------------------------------------------------------------------
# Control 2's stall report. The gate above sees one client-side maximum; this
# says where a slow statement spent its time, from the server's own statement
# history, so a red names a mechanism instead of "jitter". Pure: the Docker
# side only fetches the rows (`read_history`) and times the snapshots.
# --------------------------------------------------------------------------

HISTORY_CONSUMER = "events_statements_history_long"
HISTORY_SQL = (
    "SELECT THREAD_ID, TIMER_START, TIMER_WAIT, IFNULL(CURRENT_SCHEMA, ''), LEFT(SQL_TEXT, 200) "
    f"FROM performance_schema.{HISTORY_CONSUMER} WHERE SQL_TEXT IS NOT NULL ORDER BY TIMER_START;"
)
_PICOSECONDS = 1e12
# A sample this quick is the clock reference: its server start and its client
# send differ by the clock offset and the usual pipe transit, nothing else.
FAST_SAMPLE_SECONDS = 0.010
MIN_FAST_SAMPLES = 5
# A slow sample counts as released by a snapshot statement that ended this
# close to its acknowledgement.
RELEASED_BY_SECONDS = 0.010
# Under this share of a slow sample's time inside the server, the delay is on
# the client side (docker exec pipe, scheduling).
IN_SERVER_SHARE = 0.5
SLOWEST_REPORTED = 3
MAX_SLOW_LINES = 8

EVENT_COORDINATE = "coordinate read"
EVENT_LOCK = "LOCK or UNLOCK TABLES"
EVENT_OPEN = "snapshot open"
EVENT_DUMP = "other dump statement"
EVENT_FLUSH = "FLUSH (old path)"
EVENT_OTHER = "other statement"
# The phases a snapshot can hold a lock in; a stall released by one of these
# ending is the snapshot's own doing.
SNAPSHOT_PHASES = (EVENT_COORDINATE, EVENT_LOCK, EVENT_OPEN, EVENT_FLUSH)

_EVENT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (EVENT_COORDINATE, re.compile(r"performance_schema\.log_status|^SHOW (MASTER|BINARY LOG) STATUS", re.I)),
    (EVENT_LOCK, re.compile(r"^(LOCK|UNLOCK) TABLES", re.I)),
    (EVENT_OPEN, re.compile(r"CONSISTENT SNAPSHOT", re.I)),
    (EVENT_FLUSH, re.compile(r"^FLUSH", re.I)),
    (
        EVENT_DUMP,
        re.compile(
            r"SQL_NO_CACHE|^SHOW (CREATE|TABLE STATUS|VARIABLES|FULL TABLES|TABLES|TRIGGERS|FIELDS|COLUMNS)|SAVEPOINT"
            r"|ISOLATION LEVEL|SQL_QUOTE_SHOW_CREATE|SET SESSION (lock|wait)_timeout|CONNECTION_ID\(\)"
            r"|information_schema\.TABLES|^KILL CONNECTION|^SET |^/\*!\d+ |^SELECT @@",
            re.I,
        ),
    ),
)
# The other schema's writer (`other_posts_statement`) and the long reader.
_WRITER_TEXT = re.compile(r"INSERT INTO posts \(title\) VALUES \('(w\d+-\d+)'\)")
_READER_PREFIX = "SELECT SLEEP(10)"

# What the verdict names. A closed set: test_snapshot_probe.py asserts it.
MECH_HELD_LOCK = "held lock on other.posts (injected hold, {millis} ms)"
MECH_COORDINATE = "coordinate read"
MECH_LOCK_PHASE = "snapshot lock phase"
MECH_IN_SERVER = "in-server, no snapshot overlap"
MECH_CLIENT = "pre- or post-server (client side)"
MECH_UNATTRIBUTED = "unattributed"


@dataclasses.dataclass(frozen=True)
class ServerEvent:
    """One completed statement from the server's history, on the server's own
    timer (seconds)."""

    thread: int
    start: float
    wait: float
    schema: str
    text: str

    @property
    def end(self) -> float:
        return self.start + self.wait


@dataclasses.dataclass(frozen=True)
class Hold:
    """A lock the sabotage held on the other schema, in the client's clock."""

    start: float
    end: float
    millis: int


@dataclasses.dataclass(frozen=True)
class SlowSample:
    number: int
    offset: float
    latency: float
    pre: float | None
    inside: float | None
    post: float | None
    snapshot: int | None
    overlapping: tuple[tuple[str, int], ...]
    released_by: tuple[str, float] | None
    coordinate_gap: float | None
    mechanism: str


@dataclasses.dataclass(frozen=True)
class StallReport:
    client_worst: float
    statements: int
    baseline_worst: float
    server_available: bool
    server_note: str
    matched: int
    unattributed: int
    server_worst: float | None
    inside_p50: float | None
    offset: float | None
    offset_source: str
    slow: tuple[SlowSample, ...]
    over_limit: int
    mechanism: str

    def lines(self) -> list[str]:
        summary = (
            f"control 2 report: client worst {_ms(self.client_worst)} over {self.statements} statements "
            f"(baseline worst {_ms(self.baseline_worst)}); "
        )
        if self.server_available:
            summary += (
                f"server: {self.matched} matched, {self.unattributed} unattributed, in-server worst "
                f"{_ms(self.server_worst or 0.0)}, p50 {_ms(self.inside_p50 or 0.0)}; clock offset "
                + (f"{self.offset * 1000:.1f} ms from {self.offset_source}" if self.offset is not None else "unknown")
            )
        else:
            summary += self.server_note
        lines = [summary]
        for rank, slow in enumerate(self.slow[:MAX_SLOW_LINES], 1):
            lines.append(f"slow #{rank}: {_slow_text(slow)}")
        if len(self.slow) > MAX_SLOW_LINES:
            lines.append(f"... {len(self.slow) - MAX_SLOW_LINES} more slow statements, {self.over_limit} over the limit in all")
        return lines


def _around(gap: float) -> str:
    """`gap` is an event's end minus the acknowledgement: negative is before."""
    return f"{abs(gap) * 1000:.1f} ms {'before' if gap < 0 else 'after'}"


def _slow_text(slow: SlowSample) -> str:
    if slow.inside is None or slow.pre is None or slow.post is None:
        split = "no server record"
    else:
        split = f"pre-server {_ms(slow.pre)} + in-server {_ms(slow.inside)} + post-server {_ms(slow.post)}"
    phase = "between snapshots" if slow.snapshot is None else f"snapshot {slow.snapshot} running"
    text = f"statement {slow.number} at +{slow.offset:.3f} s, client {_ms(slow.latency)} = {split}; {phase}"
    if slow.coordinate_gap is not None:
        text += f"; nearest coordinate read ended {_around(slow.coordinate_gap)} the ack"
    if slow.released_by is not None:
        text += f"; released by {slow.released_by[0]} (ended {_around(slow.released_by[1])} the ack)"
    if slow.overlapping:
        text += "; overlapping: " + ", ".join(f"{label} x{count}" for label, count in slow.overlapping)
    return text + f"; mechanism: {slow.mechanism}"


def classify_event(text: str) -> str:
    """Which part of a snapshot (or of the harness) a statement is, by its SQL."""
    for label, pattern in _EVENT_PATTERNS:
        if pattern.search(text):
            return label
    return EVENT_OTHER


def parse_history(lines: Iterable[str]) -> list[ServerEvent]:
    """`HISTORY_SQL`'s rows. A row that does not parse is dropped; the report
    then shows it as an unattributed sample, never as a clean one."""
    events = []
    for line in lines:
        fields = line.split("\t", 4)
        if len(fields) != 5 or fields[4] == "NULL":
            continue
        try:
            events.append(
                ServerEvent(int(fields[0]), int(fields[1]) / _PICOSECONDS, int(fields[2]) / _PICOSECONDS, fields[3], fields[4])
            )
        except ValueError:
            continue
    return events


def clock_offset(pairs: Iterable[tuple[float, float, float]]) -> tuple[float, int] | None:
    """Client clock minus server clock, as the median over the fast samples of
    (client send - server start), and how many samples it rests on. A pair is
    (client send, server start, in-server seconds)."""
    gaps = [send - start for send, start, wait in pairs if wait < FAST_SAMPLE_SECONDS]
    return (statistics.median(gaps), len(gaps)) if gaps else None


def snapshot_at(intervals: Sequence[tuple[float, float]], moment: float) -> int | None:
    """The 1-based number of the snapshot running at `moment`, if any."""
    for number, (began, ended) in enumerate(intervals, 1):
        if began <= moment <= ended:
            return number
    return None


def stall_mechanism(
    *,
    latency: float,
    inside: float | None,
    released_by: tuple[str, float] | None,
    hold: Hold | None,
) -> str:
    """The one label for a slow statement. An injected hold needs no server
    record; everything else does, so a missing record is unattributed. In
    the server, a stall is the snapshot's only when a snapshot statement
    ended as it was acknowledged: a snapshot is running much of the time, so
    overlap alone proves nothing."""
    if hold is not None:
        return MECH_HELD_LOCK.format(millis=hold.millis)
    if inside is None:
        return MECH_UNATTRIBUTED
    if latency <= 0 or inside < latency * IN_SERVER_SHARE:
        return MECH_CLIENT
    if released_by is not None:
        return MECH_COORDINATE if released_by[0] == EVENT_COORDINATE else MECH_LOCK_PHASE
    return MECH_IN_SERVER


def stall_report(
    *,
    tag: str,
    window_samples: Sequence[tuple[int, float, float]],
    began: float,
    baseline_worst: float,
    events: Sequence[ServerEvent] | None,
    server_note: str = "",
    reader_sent: float | None = None,
    snapshot_intervals: Sequence[tuple[float, float]] = (),
    holds: Sequence[Hold] = (),
    limit: float = WRITER_LIMIT_SECONDS,
) -> StallReport:
    """Everything control 2 knows about its slow statements. `window_samples`
    are (statement number, client send, client latency) inside the window; a
    statement's server record is found by its unique SQL text, never by
    time. A slow statement with no record is reported as unattributed."""
    client_worst = max((latency for _, _, latency in window_samples), default=0.0)
    by_key: dict[str, ServerEvent] = {}
    reader: ServerEvent | None = None
    for event in events or ():
        match = _WRITER_TEXT.fullmatch(event.text)
        if match is not None and event.schema == OTHER:
            by_key[match.group(1)] = event
        elif event.text.startswith(_READER_PREFIX):
            reader = event
    records = [(number, send, latency, by_key.get(f"{tag}-{number}")) for number, send, latency in window_samples]
    fast = clock_offset((send, event.start, event.wait) for _, send, _, event in records if event is not None)
    offset: float | None = None
    offset_source = ""
    if fast is not None and fast[1] >= MIN_FAST_SAMPLES:
        offset, offset_source = fast[0], f"{fast[1]} fast samples"
    elif reader is not None and reader_sent is not None:
        offset, offset_source = reader_sent - reader.start, "the SLEEP anchor"
    # The digest statistic: the other schema's writer statements on the
    # server's own timer, inside the long reader's own span.
    if reader is not None:
        in_span = [e.wait for e in by_key.values() if reader.start <= e.start <= reader.end]
    else:
        in_span = [event.wait for *_, event in records if event is not None]
    excluded = {event.thread for event in by_key.values()} | ({reader.thread} if reader is not None else set())
    others = [(event, classify_event(event.text)) for event in events or () if event.thread not in excluded]
    slowest = sorted(records, key=lambda record: record[2], reverse=True)
    chosen = {record[0] for record in slowest[:SLOWEST_REPORTED]} | {record[0] for record in records if record[2] > limit}
    over_limit = sum(1 for record in records if record[2] > limit)
    slow: list[SlowSample] = []
    for number, send, latency, event in slowest:
        if number not in chosen:
            continue
        ack = send + latency
        pre = inside = post = None
        overlapping: dict[str, int] = {}
        released_by = None
        coordinate_gap = None
        if offset is not None:
            low, high = send - offset, ack - offset
            for other, label in others:
                if other.start <= high and other.end >= low:
                    overlapping[label] = overlapping.get(label, 0) + 1
            coordinates = [other.end for other, label in others if label == EVENT_COORDINATE]
            if coordinates:
                coordinate_gap = min((end - high for end in coordinates), key=abs)
            ended_near = [(abs(other.end - high), label, other.end - high) for other, label in others if label in SNAPSHOT_PHASES]
            ended_near = [near for near in ended_near if near[0] <= RELEASED_BY_SECONDS]
            if ended_near:
                _, label, gap = min(ended_near)
                released_by = (label, gap)
            if event is not None:
                inside = event.wait
                pre = max(0.0, (event.start + offset) - send)
                post = max(0.0, latency - pre - inside)
        hold = next((h for h in holds if send <= h.end and ack >= h.start), None)
        slow.append(
            SlowSample(
                number=number,
                offset=send - began,
                latency=latency,
                pre=pre,
                inside=inside,
                post=post,
                snapshot=snapshot_at(snapshot_intervals, ack),
                overlapping=tuple(sorted(overlapping.items())),
                released_by=released_by,
                coordinate_gap=coordinate_gap,
                mechanism=stall_mechanism(latency=latency, inside=inside, released_by=released_by, hold=hold),
            )
        )
    matched = sum(1 for *_, event in records if event is not None)
    return StallReport(
        client_worst=client_worst,
        statements=len(window_samples),
        baseline_worst=baseline_worst,
        server_available=events is not None,
        server_note=server_note,
        matched=matched,
        unattributed=len(records) - matched,
        server_worst=max(in_span, default=None),
        inside_p50=statistics.median(in_span) if in_span else None,
        offset=offset,
        offset_source=offset_source,
        slow=tuple(slow),
        over_limit=over_limit,
        mechanism=slow[0].mechanism if slow else MECH_UNATTRIBUTED,
    )


def checksum_verdict(source: Mapping[str, tuple[int, int | None]], replica: Mapping[str, tuple[int, int | None]]) -> Verdict:
    """Control 1. Each side maps table to (row count, CHECKSUM TABLE)."""
    if not source:
        return Verdict(False, "the source has no tables to compare")
    missing = sorted(set(source) - set(replica))
    extra = sorted(set(replica) - set(source))
    if missing or extra:
        return Verdict(False, f"table sets differ: missing on replica {missing}, extra on replica {extra}")
    differing = [
        f"{table} (source {source[table][0]} rows, replica {replica[table][0]} rows)"
        for table in sorted(source)
        if source[table] != replica[table]
    ]
    if differing:
        return Verdict(False, f"{len(differing)} of {len(source)} tables differ: " + "; ".join(differing))
    return Verdict(True, f"all {len(source)} tables match on row count and CHECKSUM TABLE")


def global_lock_verdict(rows: Iterable[Sequence[str]]) -> Verdict:
    """Control 3. Each row is (object_type, lock_type, lock_status) from
    performance_schema.metadata_locks, owned by the move account's threads.
    A GLOBAL or COMMIT lock is what FLUSH TABLES WITH READ LOCK holds. With
    no table lock seen at all the probe was blind, which is not a pass."""
    kinds = sorted({(row[0], row[1], row[2]) for row in rows})
    blocking = [kind for kind in kinds if kind[0] in ("GLOBAL", "COMMIT")]
    if blocking:
        return Verdict(False, "the move account held " + ", ".join("/".join(kind) for kind in blocking))
    if not any(kind[0] == "TABLE" and kind[2] == "GRANTED" for kind in kinds):
        return Verdict(False, "the sampler never saw the move account hold a table lock, so it could not have seen a global one")
    return Verdict(True, "locks seen: " + ", ".join("/".join(kind) for kind in kinds) + "; no GLOBAL or COMMIT")


def scoped_grant_verdict(
    errno_other_schema: int,
    errno_ftwrl: int,
    plugins: Sequence[str],
    global_privileges: Iterable[str] | None = None,
) -> Verdict:
    """Control 4. 1142 reading the other schema, 1227 on FLUSH TABLES WITH
    READ LOCK, no clone plugin, and (when read) BACKUP_ADMIN as the only
    global privilege."""
    problems = []
    if errno_other_schema != 1142:
        problems.append(f"reading the other schema gave error {errno_other_schema}, not 1142")
    if errno_ftwrl != 1227:
        problems.append(f"FLUSH TABLES WITH READ LOCK gave error {errno_ftwrl}, not 1227")
    clones = [name for name in plugins if name.lower().startswith("clone")]
    if clones:
        problems.append(f"the clone plugin is present: {clones}")
    if global_privileges is not None:
        privileges = sorted(set(global_privileges))
        if privileges != ["BACKUP_ADMIN"]:
            problems.append(f"global privileges are {privileges}, not exactly ['BACKUP_ADMIN']")
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(True, "error 1142 on the other schema, error 1227 on FTWRL, no clone plugin, BACKUP_ADMIN the only global privilege")


def bounded_wait_verdict(
    writer_waits: Sequence[float],
    timeout: float,
    ceiling: float,
    margin: float = MEASUREMENT_MARGIN_SECONDS,
) -> Verdict:
    """Control 5. `timeout` is the module's bound on a queued writer's wait,
    `ceiling` the ticket body's. Both must hold, each with `margin`."""
    if not writer_waits:
        return Verdict(False, "no writer sample in the window: the probe could not see a queue")
    worst = max(writer_waits)
    problems = []
    if worst > timeout + margin:
        problems.append(f"worst wait {_ms(worst)} exceeds the module's {_ms(timeout)} bound")
    if worst > ceiling + margin:
        problems.append(f"worst wait {_ms(worst)} exceeds the body's {_ms(ceiling)} ceiling")
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(True, f"worst queued writer wait {_ms(worst)} within the module's {_ms(timeout)} bound and the body's {_ms(ceiling)} ceiling")


def client_deadline_verdict(first_abort: str | None, deadline: float) -> Verdict:
    """Control 5, two blocked tables. The first abort must be the client's
    own deadline. The server's per-table bound fires later, after the first
    table is granted and the second wait starts."""
    if first_abort is None:
        return Verdict(False, "no attempt was aborted: the two-table wait never reached a bound")
    if f"not granted within {deadline}s" not in first_abort:
        return Verdict(False, f"the first abort was {first_abort!r}, not the {deadline}s client deadline")
    return Verdict(True, f"the client deadline fired first: {first_abort!r}")


def retry_verdict(aborted_attempts: int, attempts: int, finished_after_commit: bool) -> Verdict:
    """Control 5, the retry half: the open transaction forced at least one
    abort, and the snapshot succeeded only once that transaction had ended."""
    if aborted_attempts < 1:
        return Verdict(False, "no attempt was aborted, so the open transaction never held the lock wait")
    if attempts <= aborted_attempts:
        return Verdict(False, "every attempt was aborted: no retry succeeded")
    if not finished_after_commit:
        return Verdict(False, "the snapshot succeeded before the open transaction ended, so it did not wait")
    return Verdict(True, f"{aborted_attempts} attempt(s) aborted, attempt {attempts} succeeded after the transaction ended")


@dataclasses.dataclass(frozen=True)
class DdlFinding:
    alter_waited: bool
    altered_table_queues: bool
    text: str


def ddl_finding(
    *,
    alter_seconds: float,
    hold_remaining_seconds: float,
    altered_table_worst: float,
    other_table_worst: float,
    blog_worst: float,
    hold_only_worst: float,
    queue_threshold: float = 0.5,
) -> DdlFinding:
    """Control 6, recorded rather than gated. The ALTER is issued while
    `LOCK INSTANCE FOR BACKUP` has `hold_remaining_seconds` left."""
    waited = alter_seconds >= min(0.5, hold_remaining_seconds * 0.5)
    queues = altered_table_worst >= queue_threshold
    text = (
        f"with the instance lock held and no DDL, DML stalled at worst {_ms(hold_only_worst)}; "
        f"the ALTER on the other schema {'waited' if waited else 'did not wait'} {alter_seconds:.2f} s "
        f"(lock had {hold_remaining_seconds:.2f} s left); while it waited, DML on the altered table stalled at worst "
        f"{_ms(altered_table_worst)} ({'QUEUED behind the ALTER' if queues else 'did not queue'}), "
        f"DML on another table of that schema {_ms(other_table_worst)}, blog DML {_ms(blog_worst)}"
    )
    return DdlFinding(alter_waited=waited, altered_table_queues=queues, text=text)


def parse_errno(stderr: str) -> int:
    """The first `ERROR nnnn` a mysql client printed, 0 for none."""
    match = re.search(r"ERROR (\d+)", stderr)
    return int(match.group(1)) if match else 0


def parse_global_privileges(grant_lines: Iterable[str]) -> frozenset[str]:
    """Privileges granted ON *.* by `SHOW GRANTS` output; USAGE is nothing."""
    privileges: set[str] = set()
    for line in grant_lines:
        match = re.match(r"^GRANT (?P<privs>.+?) ON \*\.\* TO ", line)
        if match:
            privileges.update(part.strip() for part in match.group("privs").split(",") if part.strip() != "USAGE")
    return frozenset(privileges)


def pinned_image(runbook_text: str) -> str:
    """The one mysql:8.0 digest db/RUNBOOK-db.md pins."""
    pins = set(re.findall(r"mysql:8\.0@sha256:[0-9a-f]{64}", runbook_text))
    if len(pins) != 1:
        raise ValueError(f"expected exactly one mysql:8.0 digest, found {sorted(pins)}")
    return pins.pop()


def exit_code(outcomes: Mapping[int, bool], *, sabotaged: bool) -> int:
    """`outcomes` maps each control run to whether it passed."""
    if sabotaged:
        return EXIT_SABOTAGE_NOT_DETECTED if any(outcomes.values()) else EXIT_RED
    if any(not passed for number, passed in outcomes.items() if number in GATING_CONTROLS):
        return EXIT_OPTION_C_UNAVAILABLE
    if any(not passed for number, passed in outcomes.items() if number not in GATING_CONTROLS):
        return EXIT_FINDING_NOT_RECORDED
    return EXIT_PASSED


# Each verdict function against a sabotage fixture (must fail) and a healthy
# one (must pass). `--self-test` and test_snapshot_probe.py both run these.
SELF_TEST_CASES: tuple[tuple[str, bool, Callable[[], Verdict]], ...] = (
    ("writer_stall: a 10 s stall", False, lambda: writer_stall_verdict([0.004, 0.006, 10.1, 0.005], WRITER_LIMIT_SECONDS)),
    ("writer_stall: healthy", True, lambda: writer_stall_verdict([0.004, 0.006, 0.031, 0.005], WRITER_LIMIT_SECONDS)),
    ("writer_stall: no samples", False, lambda: writer_stall_verdict([], WRITER_LIMIT_SECONDS)),
    ("control_2_report: a 500 ms hold on the other schema", False, lambda: fixture_outcome(stalled=True)[0]),
    ("control_2_report: the same window, lock released", True, lambda: fixture_outcome(stalled=False)[0]),
    (
        "checksum: mismatched checksum",
        False,
        lambda: checksum_verdict({"posts": (10, 111), "users": (1, 5)}, {"posts": (10, 999), "users": (1, 5)}),
    ),
    (
        "checksum: replica missing rows",
        False,
        lambda: checksum_verdict({"posts": (10, 111)}, {"posts": (9, 111)}),
    ),
    ("checksum: healthy", True, lambda: checksum_verdict({"posts": (10, 111), "users": (1, 5)}, {"posts": (10, 111), "users": (1, 5)})),
    (
        "global_lock: a GLOBAL lock row",
        False,
        lambda: global_lock_verdict([("TABLE", "SHARED_READ_ONLY", "GRANTED"), ("GLOBAL", "SHARED", "GRANTED"), ("COMMIT", "SHARED", "GRANTED")]),
    ),
    (
        "global_lock: healthy",
        True,
        lambda: global_lock_verdict([("TABLE", "SHARED_READ_ONLY", "GRANTED"), ("TABLE", "SHARED_READ_ONLY", "PENDING")]),
    ),
    ("global_lock: blind sampler", False, lambda: global_lock_verdict([])),
    ("scoped_grant: FTWRL accepted", False, lambda: scoped_grant_verdict(1142, 0, [])),
    ("scoped_grant: other schema readable", False, lambda: scoped_grant_verdict(0, 1227, [])),
    ("scoped_grant: clone plugin loaded", False, lambda: scoped_grant_verdict(1142, 1227, ["clone"])),
    ("scoped_grant: RELOAD granted", False, lambda: scoped_grant_verdict(1142, 1227, [], ["BACKUP_ADMIN", "RELOAD"])),
    ("scoped_grant: healthy", True, lambda: scoped_grant_verdict(1142, 1227, [], ["BACKUP_ADMIN"])),
    (
        "bounded_wait: a writer waiting 10 s",
        False,
        lambda: bounded_wait_verdict([0.01, 10.0], MODULE_WAIT_BOUND_SECONDS, BODY_WAIT_CEILING_SECONDS),
    ),
    (
        "bounded_wait: past the module's bound, inside the body's",
        False,
        lambda: bounded_wait_verdict([0.01, 2.1], MODULE_WAIT_BOUND_SECONDS, BODY_WAIT_CEILING_SECONDS),
    ),
    (
        "bounded_wait: healthy",
        True,
        lambda: bounded_wait_verdict([0.01, 1.25, 0.02], MODULE_WAIT_BOUND_SECONDS, BODY_WAIT_CEILING_SECONDS),
    ),
    ("retry: succeeded before the transaction ended", False, lambda: retry_verdict(1, 2, False)),
    ("retry: no abort", False, lambda: retry_verdict(0, 1, True)),
    ("retry: healthy", True, lambda: retry_verdict(3, 4, True)),
)


def self_test() -> list[str]:
    """The labels of the cases whose verdict was not the expected one."""
    return [label for label, expected, case in SELF_TEST_CASES if case().passed != expected]


# --------------------------------------------------------------------------
# Ghost-shaped schemas. Fourteen tables, foreign keys, a trigger and a view:
# the shape the lock and the dump see, not Ghost's migration set.
# --------------------------------------------------------------------------

BLOG_TABLES = (
    "users", "posts", "tags", "posts_tags", "settings", "members", "newsletters",
    "members_newsletters", "products", "members_products", "offers", "integrations", "api_keys", "emails",
)


def blog_ddl(schema: str = BLOG) -> str:
    return f"""
CREATE DATABASE {schema};
USE {schema};
CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL, email VARCHAR(191) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE posts (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255) NOT NULL, slug VARCHAR(191) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'draft', author_id INT NOT NULL, version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT posts_author FOREIGN KEY (author_id) REFERENCES users (id));
CREATE TABLE tags (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL, slug VARCHAR(191) NOT NULL UNIQUE);
CREATE TABLE posts_tags (id INT AUTO_INCREMENT PRIMARY KEY, post_id INT NOT NULL, tag_id INT NOT NULL, sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT posts_tags_post FOREIGN KEY (post_id) REFERENCES posts (id),
  CONSTRAINT posts_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id));
CREATE TABLE settings (id INT AUTO_INCREMENT PRIMARY KEY, `key` VARCHAR(64) NOT NULL UNIQUE, value TEXT);
CREATE TABLE members (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(191) NOT NULL UNIQUE, status VARCHAR(50) NOT NULL DEFAULT 'free');
CREATE TABLE newsletters (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL);
CREATE TABLE members_newsletters (id INT AUTO_INCREMENT PRIMARY KEY, member_id INT NOT NULL, newsletter_id INT NOT NULL,
  CONSTRAINT mn_member FOREIGN KEY (member_id) REFERENCES members (id),
  CONSTRAINT mn_newsletter FOREIGN KEY (newsletter_id) REFERENCES newsletters (id));
CREATE TABLE products (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL);
CREATE TABLE members_products (id INT AUTO_INCREMENT PRIMARY KEY, member_id INT NOT NULL, product_id INT NOT NULL,
  CONSTRAINT mp_member FOREIGN KEY (member_id) REFERENCES members (id),
  CONSTRAINT mp_product FOREIGN KEY (product_id) REFERENCES products (id));
CREATE TABLE offers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL, product_id INT NOT NULL,
  CONSTRAINT offers_product FOREIGN KEY (product_id) REFERENCES products (id));
CREATE TABLE integrations (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL);
CREATE TABLE api_keys (id INT AUTO_INCREMENT PRIMARY KEY, integration_id INT NOT NULL, secret_hash CHAR(32) NOT NULL,
  CONSTRAINT api_keys_integration FOREIGN KEY (integration_id) REFERENCES integrations (id));
CREATE TABLE emails (id INT AUTO_INCREMENT PRIMARY KEY, post_id INT NOT NULL, status VARCHAR(50) NOT NULL,
  CONSTRAINT emails_post FOREIGN KEY (post_id) REFERENCES posts (id));
CREATE TRIGGER posts_touch BEFORE UPDATE ON posts FOR EACH ROW SET NEW.version = OLD.version + 1, NEW.updated_at = CURRENT_TIMESTAMP;
CREATE VIEW published_posts AS SELECT id, title, slug FROM posts WHERE status = 'published';
INSERT INTO users (name, email) VALUES ('OWNER', 'owner@example.invalid');
INSERT INTO settings (`key`, value) VALUES ('counter', '0'), ('title', 'TITLE');
INSERT INTO tags (name, slug) VALUES ('TAG_A', 'tag-a'), ('TAG_B', 'tag-b');
INSERT INTO newsletters (name) VALUES ('NEWSLETTER');
INSERT INTO products (name) VALUES ('PRODUCT');
INSERT INTO offers (name, product_id) VALUES ('OFFER', 1);
INSERT INTO integrations (name) VALUES ('INTEGRATION');
INSERT INTO api_keys (integration_id, secret_hash) VALUES (1, MD5('placeholder'));
INSERT INTO posts (title, slug, status, author_id)
  WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 300)
  SELECT CONCAT('seed ', n), CONCAT('seed-', n), IF(n % 2, 'published', 'draft'), 1 FROM seq;
INSERT INTO posts_tags (post_id, tag_id) SELECT id, 1 + id % 2 FROM posts;
INSERT INTO members (email, status)
  WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500)
  SELECT CONCAT('member', n, '@example.invalid'), 'free' FROM seq;
INSERT INTO members_newsletters (member_id, newsletter_id) SELECT id, 1 FROM members;
"""


def other_ddl(schema: str = OTHER) -> str:
    return f"""
CREATE DATABASE {schema};
USE {schema};
CREATE TABLE posts (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(191) NOT NULL);
CREATE TABLE settings (id INT PRIMARY KEY, v INT NOT NULL);
CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL);
INSERT INTO posts (title) VALUES ('seed');
INSERT INTO settings VALUES (1, 0);
INSERT INTO items (name) VALUES ('seed');
"""


def blog_statement(tag: str, n: int) -> str:
    """A Ghost-like write transaction: several tables, a foreign key, the
    trigger. Its metadata locks are held until the commit."""
    return (
        "START TRANSACTION; "
        f"INSERT INTO posts (title, slug, status, author_id) VALUES ('{tag}-{n}', '{tag}-{n}', 'draft', 1); "
        "SET @p = LAST_INSERT_ID(); "
        "UPDATE posts SET status = 'published' WHERE id = @p; "
        "INSERT INTO emails (post_id, status) VALUES (@p, 'pending'); "
        f"UPDATE settings SET value = '{n}' WHERE `key` = 'counter'; "
        "COMMIT;"
    )


def blog_posts_statement(tag: str, n: int) -> str:
    return f"INSERT INTO posts (title, slug, status, author_id) VALUES ('{tag}-{n}', '{tag}-{n}', 'draft', 1);"


def blog_members_statement(tag: str, n: int) -> str:
    return f"INSERT INTO members (email) VALUES ('{tag}-{n}@example.invalid');"


def blog_settings_statement(tag: str, n: int) -> str:
    return f"UPDATE settings SET value = '{n}' WHERE `key` = 'title';"


def other_posts_statement(tag: str, n: int) -> str:
    return f"INSERT INTO posts (title) VALUES ('{tag}-{n}');"


def other_settings_statement(tag: str, n: int) -> str:
    return "UPDATE settings SET v = v + 1 WHERE id = 1;"


# --------------------------------------------------------------------------
# Container plumbing
# --------------------------------------------------------------------------


class ProofError(Exception):
    """The proof itself could not run or observe something."""


class SessionEnded(ProofError):
    def __init__(self, stderr: str, elapsed: float) -> None:
        super().__init__(f"the mysql session ended after {elapsed:.3f}s: {stderr.strip()[:300]}")
        self.stderr = stderr
        self.elapsed = elapsed


def _client_env(password: str) -> dict[str, str]:
    """The password reaches `docker exec` only as an environment variable,
    named (not valued) on its command line, so it is never in argv."""
    env = dict(os.environ)
    env["MYSQL_PWD"] = password
    return env


class Server:
    def __init__(self, name: str, root_password: str) -> None:
        self.name = name
        self._root_password = root_password

    def exec_argv(self, inner: Sequence[str], *, interactive: bool = False) -> list[str]:
        return ["docker", "exec", *(["-i"] if interactive else []), "-e", "MYSQL_PWD", self.name, *inner]

    def popen(self, inner: Sequence[str], password: str, **kwargs) -> subprocess.Popen:
        return subprocess.Popen(self.exec_argv(inner, interactive=True), env=_client_env(password), **kwargs)

    def run(
        self,
        sql: str,
        *,
        user: str = "root",
        password: str | None = None,
        database: str | None = None,
        extra: Sequence[str] = (),
        column_names: bool = False,
        timeout: float = 300,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        argv = ["mysql", f"--user={user}", *([] if column_names else ["-N", "-B"]), *extra, *([database] if database else [])]
        result = subprocess.run(
            self.exec_argv(argv, interactive=True),
            input=sql,
            env=_client_env(password if password is not None else self._root_password),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if check and result.returncode != 0:
            raise ProofError(f"{self.name}: mysql failed ({sql[:80]!r}...): {result.stderr.strip()[:400]}")
        return result

    def query(self, sql: str, **kwargs) -> list[list[str]]:
        out = self.run(sql, **kwargs).stdout
        return [line.split("\t") for line in out.splitlines() if line != ""]

    def load_file(self, path: pathlib.Path) -> None:
        with open(path, "rb") as handle:
            result = subprocess.run(
                self.exec_argv(["mysql", "--user=root"], interactive=True),
                stdin=handle,
                env=_client_env(self._root_password),
                capture_output=True,
                check=False,
                timeout=600,
            )
        if result.returncode != 0:
            raise ProofError(f"{self.name}: loading {path.name} failed: {result.stderr.decode(errors='replace')[:400]}")

    def session(self, *, user: str = "root", password: str | None = None, database: str | None = None) -> "Session":
        return Session(self, user, password if password is not None else self._root_password, database)


class Session:
    """One persistent `mysql` client, so a latency probe measures the
    server and not a process spawn. A sentinel row ends each answer."""

    def __init__(self, server: Server, user: str, password: str, database: str | None) -> None:
        argv = ["mysql", f"--user={user}", "-N", "-B", "-n", *([database] if database else [])]
        self.process = server.popen(argv, password, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._stderr: list[str] = []
        self._drain = threading.Thread(target=self._drain_stderr, daemon=True)
        self._drain.start()
        self._sequence = 0

    def _drain_stderr(self) -> None:
        try:
            for raw in self.process.stderr:
                self._stderr.append(raw.decode(errors="replace"))
        except (OSError, ValueError):
            pass

    def run(self, sql: str) -> tuple[list[str], float]:
        self._sequence += 1
        token = f"__probe_{self._sequence}__"
        began = time.monotonic()
        try:
            self.process.stdin.write(f"{sql}\nSELECT '{token}';\n".encode())
            self.process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            raise SessionEnded(self._stderr_text(), time.monotonic() - began) from None
        lines: list[str] = []
        while True:
            raw = self.process.stdout.readline()
            if not raw:
                raise SessionEnded(self._stderr_text(), time.monotonic() - began)
            line = raw.decode(errors="replace").rstrip("\n")
            if line == token:
                return lines, time.monotonic() - began
            lines.append(line)

    def _stderr_text(self) -> str:
        self._drain.join(2.0)
        return "".join(self._stderr)

    def close(self) -> None:
        for stream in (self.process.stdin,):
            try:
                stream.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
        for stream in (self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError:
                pass


class Writer(threading.Thread):
    """A continuous writer on one persistent session, timing each statement
    from send to acknowledgement."""

    _ids = itertools.count(1)

    def __init__(self, server: Server, database: str, statement: Callable[[str, int], str], *, pause: float = 0.02) -> None:
        super().__init__(daemon=True)
        self.tag = f"w{next(Writer._ids)}"
        self._server = server
        self._database = database
        self._statement = statement
        self._pause = pause
        self.samples: list[tuple[float, float]] = []
        self.deadlocks = 0
        self.error: ProofError | None = None
        self._halt = threading.Event()
        self._session = server.session(database=database)

    def run(self) -> None:
        sequence = 0
        try:
            while not self._halt.is_set():
                sequence += 1
                began = time.monotonic()
                try:
                    self._session.run(self._statement(self.tag, sequence))
                except SessionEnded as ended:
                    # A write that is the victim of a metadata deadlock with a
                    # pending LOCK TABLES is rolled back with error 1213. The
                    # write fails with 1213 unless the application retries
                    # it; nothing here shows Ghost does. Counted and reported,
                    # and the writer carries on.
                    if parse_errno(ended.stderr) != 1213:
                        raise
                    self.deadlocks += 1
                    self._session.close()
                    self._session = self._server.session(database=self._database)
                self.samples.append((began, time.monotonic() - began))
                time.sleep(self._pause)
        except ProofError as exc:
            self.error = exc

    def finish(self) -> list[tuple[float, float]]:
        self._halt.set()
        self.join(timeout=120)
        self._session.close()
        if self.error is not None:
            raise ProofError(f"writer {self.tag} died: {self.error}")
        return self.samples


class LockSampler(threading.Thread):
    """Reads the move account's metadata locks as fast as one session can,
    keeping every distinct (object type, lock type, status) and how many
    samples held a granted table lock."""

    SQL = (
        "SELECT ml.OBJECT_TYPE, ml.LOCK_TYPE, ml.LOCK_STATUS "
        "FROM performance_schema.metadata_locks ml JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID "
        f"WHERE t.PROCESSLIST_USER = '{MOVER}';"
    )

    def __init__(self, server: Server) -> None:
        super().__init__(daemon=True)
        self.rows: set[tuple[str, str, str]] = set()
        self.samples = 0
        self.table_lock_samples = 0
        self.error: ProofError | None = None
        self._halt = threading.Event()
        self._session = server.session()

    def run(self) -> None:
        try:
            while not self._halt.is_set():
                lines, _ = self._session.run(self.SQL)
                self.samples += 1
                rows = {tuple(line.split("\t")) for line in lines}
                self.rows |= rows
                if any(row[0] == "TABLE" and row[2] == "GRANTED" for row in rows):
                    self.table_lock_samples += 1
        except ProofError as exc:
            self.error = exc

    def finish(self) -> None:
        self._halt.set()
        self.join(timeout=60)
        self._session.close()
        if self.error is not None:
            raise ProofError(f"lock sampler died: {self.error}")


def container_popen(server: Server):
    """What `ClientFactory` hands its `popen`, run inside the container: the
    option file's password (an inherited fd) becomes the exec's MYSQL_PWD."""

    def popen(argv, *, env=None, pass_fds=(), **kwargs):
        password = None
        inner = []
        for arg in argv:
            if arg.startswith("--defaults-extra-file=/dev/fd/"):
                fd = int(arg.rsplit("/", 1)[1])
                password = os.read(fd, 4096).decode().split("password=", 1)[1].strip()
            else:
                inner.append(arg)
        if password is None:
            raise ProofError("the client factory passed no option file")
        return server.popen(inner, password, **kwargs)

    return popen


@dataclasses.dataclass
class Passwords:
    root: str
    mover: str
    repl: str
    nobackup: str

    @classmethod
    def read(cls, workdir: pathlib.Path) -> "Passwords":
        return cls(*(((workdir / f"{name}.pw").read_text().strip()) for name in ("root", "mover", "repl", "nobackup")))


@dataclasses.dataclass
class Ctx:
    source: Server
    replica: Server
    workdir: pathlib.Path
    passwords: Passwords
    sabotage: str | None
    notes: dict[str, int] = dataclasses.field(default_factory=dict)
    texts: dict[str, str] = dataclasses.field(default_factory=dict)

    def say(self, text: str) -> None:
        print(text, flush=True)

    def sabotaged(self, name: str) -> bool:
        return self.sabotage == name


@dataclasses.dataclass
class ControlResult:
    number: int
    title: str
    verdict: Verdict
    numbers: list[str]


def read_log_status(server: Server) -> tuple[str, int]:
    rows = server.query(
        "SELECT LOCAL->>'$.binary_log_file', LOCAL->>'$.binary_log_position' FROM performance_schema.log_status;"
    )
    return rows[0][0], int(rows[0][1])


def take_snapshot(
    ctx: Ctx, name: str, *, limits: bs.Limits | None = None, log: Callable[[str], None] = lambda message: None
) -> tuple[bs.SnapshotReport, pathlib.Path]:
    """The real module, as the move account, then the dump written with the
    coordinates comment as its first line, exactly as the callers do."""
    factory = bs.ClientFactory(
        connection_args=[f"--user={MOVER}"], password=ctx.passwords.mover, env={}, popen=container_popen(ctx.source)
    )
    dump, report = bs.take_bounded_snapshot(
        factory=factory, schemas=[BLOG], dump_args=DUMP_ARGS, limits=limits or bs.Limits(), log=log
    )
    path = ctx.workdir / name
    with open(path, "wb") as handle:
        handle.write(report.coordinates_comment())
        shutil.copyfileobj(dump.process.stdout, handle)
    returncode = dump.process.wait(timeout=300)
    dump.stderr.join(5)
    if returncode != 0:
        raise ProofError(f"mysqldump failed ({returncode}): {dump.stderr.text()[:400]}")
    return report, path


def worst_of(samples: Iterable[tuple[float, float]]) -> float:
    return max((latency for _, latency in samples), default=0.0)


def replica_status(server: Server) -> dict[str, str]:
    out = server.run("SHOW REPLICA STATUS", column_names=True, extra=("--vertical",)).stdout
    return {m.group(1): m.group(2) for m in re.finditer(r"^\s*(\w+): ?(.*)$", out, re.M)}


def wait_caught_up(replica: Server, log_file: str, position: int, timeout: float = 240) -> str | None:
    """None once the replica has executed the source's final position, else
    the reason it did not (its SQL error, or a timeout)."""
    deadline = time.monotonic() + timeout
    status: dict[str, str] = {}
    while time.monotonic() < deadline:
        status = replica_status(replica)
        if status.get("Last_SQL_Errno", "0") not in ("0", ""):
            return f"replica SQL thread stopped: error {status['Last_SQL_Errno']}: {status.get('Last_SQL_Error', '')[:200]}"
        if status.get("Relay_Source_Log_File") == log_file and status.get("Exec_Source_Log_Pos") == str(position):
            return None
        time.sleep(0.5)
    return f"replica did not reach {log_file}:{position} in {timeout:.0f}s (at {status.get('Relay_Source_Log_File')}:{status.get('Exec_Source_Log_Pos')})"


def table_sums(server: Server) -> dict[str, tuple[int, int | None]]:
    tables = [
        row[0]
        for row in server.query(
            f"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{BLOG}' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;"
        )
    ]
    if not tables:
        return {}
    sql = "".join(f"SELECT COUNT(*) FROM {BLOG}.`{t}`; CHECKSUM TABLE {BLOG}.`{t}`;\n" for t in tables)
    lines = server.run(sql).stdout.splitlines()
    sums: dict[str, tuple[int, int | None]] = {}
    for table, (count, checksum) in zip(tables, zip(lines[0::2], lines[1::2], strict=True), strict=True):
        value = checksum.split("\t")[1]
        sums[table] = (int(count), None if value == "NULL" else int(value))
    return sums


def reset_replica(ctx: Ctx) -> None:
    for statement in ("STOP REPLICA", "RESET REPLICA ALL", f"DROP DATABASE IF EXISTS {BLOG}"):
        ctx.replica.run(statement, check=False)


def start_replication(ctx: Ctx, log_file: str, position: int) -> None:
    if not re.fullmatch(r"[\w.\-]+", log_file):
        raise ProofError(f"unexpected binary log name {log_file!r}")
    ctx.replica.run(
        f"CHANGE REPLICATION SOURCE TO SOURCE_HOST='{ctx.source.name}', SOURCE_USER='{REPLICATION_USER}', "
        f"SOURCE_PASSWORD='{ctx.passwords.repl}', SOURCE_LOG_FILE='{log_file}', SOURCE_LOG_POS={int(position)}, "
        "SOURCE_SSL=1, SOURCE_CONNECT_RETRY=2; START REPLICA;"
    )


def seed(ctx: Ctx) -> None:
    ctx.source.run(
        blog_ddl()
        + other_ddl()
        + f"CREATE USER '{MOVER}'@'localhost' IDENTIFIED BY '{ctx.passwords.mover}';\n"
        + f"GRANT SELECT, LOCK TABLES, SHOW VIEW, TRIGGER ON {BLOG}.* TO '{MOVER}'@'localhost';\n"
        + f"GRANT BACKUP_ADMIN ON *.* TO '{MOVER}'@'localhost';\n"
        + f"CREATE USER '{NOBACKUP}'@'localhost' IDENTIFIED BY '{ctx.passwords.nobackup}';\n"
        + f"GRANT SELECT, LOCK TABLES ON {BLOG}.* TO '{NOBACKUP}'@'localhost';\n"
        + f"CREATE USER '{REPLICATION_USER}'@'%' IDENTIFIED BY '{ctx.passwords.repl}' REQUIRE SSL;\n"
        + f"GRANT REPLICATION SLAVE ON *.* TO '{REPLICATION_USER}'@'%';\n"
    )
    # The ticket body's grant list is SELECT on the schema plus BACKUP_ADMIN.
    # Observed first-run: that is not enough to read log_status, which is a
    # table and needs its own SELECT. Record the failure, then grant that one
    # table (not the schema, not *.*).
    ungranted = ctx.source.run(
        "SELECT LOCAL FROM performance_schema.log_status;", user=MOVER, password=ctx.passwords.mover, check=False
    )
    ctx.notes["log_status_errno_without_table_grant"] = parse_errno(ungranted.stderr)
    ctx.source.run(f"GRANT SELECT ON performance_schema.log_status TO '{MOVER}'@'localhost';")
    # The BACKUP_ADMIN step: the same account minus BACKUP_ADMIN, with its
    # own log_status SELECT, reads log_status. The exact error (or success)
    # is recorded, not gated.
    ctx.source.run(f"GRANT SELECT ON performance_schema.log_status TO '{NOBACKUP}'@'localhost';")
    without_backup = ctx.source.run(
        "SELECT LOCAL FROM performance_schema.log_status;",
        user=NOBACKUP,
        password=ctx.passwords.nobackup,
        check=False,
    )
    ctx.notes["log_status_errno_without_backup_admin"] = parse_errno(without_backup.stderr)
    error_lines = [line for line in without_backup.stderr.splitlines() if line.startswith("ERROR")]
    ctx.texts["log_status_without_backup_admin"] = error_lines[0] if error_lines else "read succeeded, no error"


def _check_writers(*writers: Writer) -> list[tuple[float, float]]:
    return [sample for writer in writers for sample in writer.finish()]


# --------------------------------------------------------------------------
# The six controls
# --------------------------------------------------------------------------


def control_1(ctx: Ctx) -> ControlResult:
    """Consistent snapshot and coordinates, replica seeded under writes."""
    reset_replica(ctx)
    blog = Writer(ctx.source, BLOG, blog_statement)
    other = Writer(ctx.source, OTHER, other_posts_statement)
    blog.start()
    other.start()
    time.sleep(1.5)
    numbers = []
    try:
        report, dump_path = take_snapshot(ctx, "seed.sql")
        coordinates = (report.log_file, report.log_position)
        if ctx.sabotaged("coordinates-after-write"):
            ctx.source.run(
                f"INSERT INTO {BLOG}.posts (title, slug, status, author_id) VALUES ('injected', 'injected-after-unlock', 'draft', 1);"
            )
            coordinates = read_log_status(ctx.source)
            numbers.append("sabotage: a blog write injected between the unlock and the coordinate read")
        with open(dump_path, "rb") as handle:
            first_line = handle.readline().decode().rstrip("\n")
        match = extract_tenant_binlog.SOURCE_DATA_PATTERN.match(first_line)
        if match is None or (match.group("log_file"), int(match.group("position"))) != (report.log_file, report.log_position):
            raise ProofError(f"the dump's first line does not parse as the module's coordinates: {first_line!r}")
        ctx.replica.load_file(dump_path)
        start_replication(ctx, *coordinates)
        time.sleep(3)
    finally:
        blog_samples = len(blog.samples)
        _check_writers(blog, other)
    final = read_log_status(ctx.source)
    failure = wait_caught_up(ctx.replica, *final)
    source_sums = table_sums(ctx.source)
    replica_sums = table_sums(ctx.replica)
    verdict = checksum_verdict(source_sums, replica_sums)
    if failure is not None:
        verdict = Verdict(False, failure + ("; " + verdict.reason if not verdict.passed else ""))
    numbers += [
        f"snapshot at {report.log_file}:{report.log_position}, lock wait {report.lock_wait_seconds * 1000:.0f} ms, "
        f"hold {report.hold_seconds * 1000:.0f} ms, {report.tables_locked} tables locked, attempts {report.attempts}",
        f"replica seeded at {coordinates[0]}:{coordinates[1]} under {blog_samples} blog write transactions "
        f"({blog.deadlocks} rolled back as deadlock victims, error 1213); caught up to {final[0]}:{final[1]}",
        f"{len(source_sums)} tables, {sum(count for count, _ in source_sums.values())} rows on the source",
    ]
    return ControlResult(1, "consistent snapshot and coordinates", verdict, numbers)


@dataclasses.dataclass
class LongReaderRun:
    other_samples: list[tuple[float, float]]
    window: tuple[float, float]
    baseline_worst: float
    snapshots: int
    # What the stall report needs. The defaults are the no-instrument case.
    tag: str = ""
    reader_sent: float | None = None
    snapshot_intervals: list[tuple[float, float]] = dataclasses.field(default_factory=list)
    holds: list[Hold] = dataclasses.field(default_factory=list)
    events: list[ServerEvent] | None = None
    history_note: str = "server-side history not read"
    # What the window ran under (see relaxed_durability); empty when not set.
    durability: str = ""


@dataclasses.dataclass(frozen=True)
class ScenarioActions:
    """What one probe snapshots with, so the scenario below is written once.
    `snapshot` takes one snapshot of the blog; `old_path` is the retired
    `mysqldump --source-data=2`, with the grant it needs given and taken back
    by the callable itself."""

    snapshot: Callable[[], object]
    old_path: Callable[[], object]


def _grant_old_path(ctx: Ctx) -> None:
    ctx.source.run(f"GRANT RELOAD, REPLICATION CLIENT ON *.* TO '{MOVER}'@'localhost';")


def _revoke_old_path(ctx: Ctx) -> None:
    ctx.source.run(f"REVOKE RELOAD, REPLICATION CLIENT ON *.* FROM '{MOVER}'@'localhost';", check=False)


def old_path_dump(ctx: Ctx) -> None:
    """The path this proof exists to retire: `mysqldump --source-data=2`,
    which flushes tables and then takes FLUSH TABLES WITH READ LOCK. Needs
    RELOAD, granted by the caller."""
    dump = ctx.source.popen(
        ["mysqldump", f"--user={MOVER}", "--single-transaction", "--source-data=2", "--no-tablespaces", "--databases", BLOG],
        ctx.passwords.mover,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    _, stderr = dump.communicate(timeout=120)
    if dump.returncode != 0:
        raise ProofError(f"the old-path mysqldump failed: {stderr.decode(errors='replace')[:300]}")


def old_path_sequence(ctx: Ctx) -> None:
    """The retired path as this probe runs it: the grant it needs, the dump,
    and the grant taken back whatever happens."""
    _grant_old_path(ctx)
    try:
        old_path_dump(ctx)
    finally:
        _revoke_old_path(ctx)


# `other-lock`: a real lock on the other schema's table, held this long, this
# long into the window. Control 2 must go red naming it.
INJECTED_HOLD_SECONDS = 0.5
INJECTED_HOLD_DELAY_SECONDS = 3.0


def hold_other_lock(
    session: Session,
    hold_seconds: float = INJECTED_HOLD_SECONDS,
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Hold:
    """`LOCK TABLES other.posts READ` on its own session for `hold_seconds`,
    then `UNLOCK TABLES`. The other schema's writer needs a write lock on
    that table, so it waits for exactly this long."""
    session.run(f"LOCK TABLES {OTHER}.posts READ;")
    start = clock()
    try:
        sleep(hold_seconds)
    finally:
        session.run("UNLOCK TABLES;")
    return Hold(start, clock(), round(hold_seconds * 1000))


def enable_history(ctx: Ctx) -> str | None:
    """As root, switch on the statement-history consumer and empty it, before
    the timed window. None on success, else why the server side is not
    visible (the control still judges the client-side maximum)."""
    try:
        ctx.source.run(
            f"UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = '{HISTORY_CONSUMER}'; "
            f"TRUNCATE TABLE performance_schema.{HISTORY_CONSUMER};"
        )
    except ProofError as exc:
        return f"server-side history unavailable: {exc}"
    return None


def read_history(ctx: Ctx) -> tuple[list[ServerEvent] | None, str]:
    """Read once, as root, after the window and after every writer has
    stopped: nothing here is inside the timed region."""
    try:
        return parse_history(ctx.source.run(HISTORY_SQL).stdout.splitlines()), ""
    except ProofError as exc:
        return None, f"server-side history unavailable: {exc}"


# What control 2's window runs the source under. The source's real settings
# (sync_binlog=1, innodb_flush_log_at_trx_commit=1) make every commit wait on
# the runner's disk, and a hosted runner's disk sometimes takes 150 to 570 ms
# to fsync: a stall in every variant measured, with no snapshot running at all,
# and gone with the fsync removed. Control 2's claim is that the snapshot does
# not stall another schema's commits, not that the disk is fast. Only this
# window is relaxed; every other control keeps real fsync.
DURABILITY_RELAXED = (("sync_binlog", 0), ("innodb_flush_log_at_trx_commit", 2))
_DURABILITY_READ_SQL = "SELECT " + ", ".join(f"@@GLOBAL.{name}" for name, _ in DURABILITY_RELAXED) + ";"


def _durability_assignments(values: Iterable[object]) -> str:
    return ", ".join(f"{name}={value}" for (name, _), value in zip(DURABILITY_RELAXED, values))


@contextlib.contextmanager
def relaxed_durability(source: Server):
    """Relax the source's commit durability for the body, and put back what
    was there on every exit path (an assertion, a sabotage, an interrupt, a
    failure to relax). The one home of the setting and of its restore; yields
    a line saying what ran. A restore that fails is an error, never silent."""
    original = source.query(_DURABILITY_READ_SQL)[0]
    relaxed = tuple(value for _, value in DURABILITY_RELAXED)
    try:
        source.run(f"SET GLOBAL {_durability_assignments(relaxed)};")
        now = tuple(source.query(_DURABILITY_READ_SQL)[0])
        if now != tuple(str(value) for value in relaxed):
            raise ProofError(f"{source.name}: durability not relaxed, reads {now}")
        yield (
            f"commit durability relaxed for this window only ({_durability_assignments(relaxed)}, "
            f"were {_durability_assignments(original)}), restored after it"
        )
    finally:
        source.run(f"SET GLOBAL {_durability_assignments(original)};")


def long_reader_scenario(ctx: Ctx, actions: ScenarioActions) -> LongReaderRun:
    """The one scenario control 2 has, in both probes, run with the source's
    commit durability relaxed for its window only (relaxed_durability)."""
    with relaxed_durability(ctx.source) as durability:
        run = _long_reader_window(ctx, actions)
    return dataclasses.replace(run, durability=durability)


def _long_reader_window(ctx: Ctx, actions: ScenarioActions) -> LongReaderRun:
    """A SELECT SLEEP(10) reads the other schema's table while the blog is
    snapshotted by `actions.snapshot`, or under sabotage by the old path
    (RELOAD plus `mysqldump --source-data=2`), or with a lock really held on
    the other schema (`other-lock`). The other schema's continuous writer is
    the only probe running; its statement history is read after the window."""
    old_path = ctx.sabotaged("old-path")
    inject = ctx.sabotaged("other-lock")
    history_note = enable_history(ctx)
    writer = Writer(ctx.source, OTHER, other_posts_statement)
    reader = ctx.source.session(database=OTHER)
    snapshots = 0
    intervals: list[tuple[float, float]] = []
    holds: list[Hold] = []
    hold_errors: list[ProofError] = []
    holder: threading.Thread | None = None
    reader_sent: list[float] = []
    writer.start()
    try:
        time.sleep(2.5)
        baseline_worst = worst_of(writer.samples[2:])
        reader_done = threading.Event()
        reader_error: list[ProofError] = []

        def hold_reader() -> None:
            try:
                reader_sent.append(time.monotonic())
                reader.run("SELECT SLEEP(10) FROM posts LIMIT 1;")
            except ProofError as exc:
                reader_error.append(exc)
            finally:
                reader_done.set()

        def hold_lock_mid_window() -> None:
            time.sleep(INJECTED_HOLD_DELAY_SECONDS)
            locker = ctx.source.session()
            try:
                holds.append(hold_other_lock(locker))
            except ProofError as exc:
                hold_errors.append(exc)
            finally:
                locker.close()

        threading.Thread(target=hold_reader, daemon=True).start()
        for _ in range(100):
            if ctx.source.query("SELECT COUNT(*) FROM performance_schema.processlist WHERE INFO LIKE 'SELECT SLEEP(10)%';")[0][0] != "0":
                break
            time.sleep(0.1)
        else:
            raise ProofError("the long reader never started")
        began = time.monotonic()
        if inject:
            holder = threading.Thread(target=hold_lock_mid_window, daemon=True)
            holder.start()
        if old_path:
            moment = time.monotonic()
            actions.old_path()
            intervals.append((moment, time.monotonic()))
            snapshots = 1
        else:
            while not reader_done.is_set():
                moment = time.monotonic()
                actions.snapshot()
                intervals.append((moment, time.monotonic()))
                snapshots += 1
                time.sleep(0.2)
        reader_done.wait(timeout=60)
        if holder is not None:
            holder.join(timeout=30)
            if hold_errors:
                raise hold_errors[0]
        if reader_error:
            raise reader_error[0]
        ended = time.monotonic()
    finally:
        reader.close()
        samples = writer.finish()
    events: list[ServerEvent] | None = None
    if history_note is None:
        events, history_note = read_history(ctx)
    return LongReaderRun(
        samples,
        (began, ended),
        baseline_worst,
        snapshots,
        tag=writer.tag,
        reader_sent=reader_sent[0] if reader_sent else None,
        snapshot_intervals=intervals,
        holds=holds,
        events=events,
        history_note=history_note or "",
    )


def control_2_outcome(run: LongReaderRun, *, old_path: bool) -> tuple[Verdict, list[str]]:
    """The one judgement and report of control 2, for both probes."""
    in_window = indexed_between(run.other_samples, *run.window)
    report = stall_report(
        tag=run.tag,
        window_samples=in_window,
        began=run.window[0],
        baseline_worst=run.baseline_worst,
        events=run.events,
        server_note=run.history_note,
        reader_sent=run.reader_sent,
        snapshot_intervals=run.snapshot_intervals,
        holds=run.holds,
    )
    verdict = writer_stall_verdict([latency for _, _, latency in in_window], WRITER_LIMIT_SECONDS, mechanism=report.mechanism)
    lines = [
        f"a SELECT SLEEP(10) held other.posts for {run.window[1] - run.window[0]:.1f} s while "
        f"{run.snapshots} {'old-path dump' if old_path else 'snapshot(s)'} ran",
        f"baseline worst `other` statement before it: {_ms(run.baseline_worst)}",
        *([run.durability] if run.durability else []),
        *report.lines(),
    ]
    return verdict, lines


def fixture_outcome(*, stalled: bool) -> tuple[Verdict, list[str]]:
    """Control 2's judgement of a canned window, no Docker: 330 statements of
    4 ms and an injected hold on the other schema at 3 s. With `stalled`, the
    statement that began as the lock was taken waited it out (500 ms); without,
    the same window and hold with the writer unaffected."""
    samples = [(100.0 + 0.03 * number, 0.004) for number in range(330)]
    if stalled:
        samples[100] = (samples[100][0], 0.5)
    run = LongReaderRun(
        samples, (100.0, 110.0), 0.004, 29, tag="w1", holds=[Hold(103.0, 103.5, 500)], history_note="server-side history not read"
    )
    return control_2_outcome(run, old_path=False)


def control_2(ctx: Ctx) -> ControlResult:
    """Another schema's writes are not blocked."""
    actions = ScenarioActions(snapshot=lambda: take_snapshot(ctx, "under-reader.sql"), old_path=lambda: old_path_sequence(ctx))
    run = long_reader_scenario(ctx, actions)
    verdict, numbers = control_2_outcome(run, old_path=ctx.sabotaged("old-path"))
    return ControlResult(2, "another schema's writes are not blocked", verdict, numbers)


def control_3(ctx: Ctx) -> ControlResult:
    """No GLOBAL metadata lock held by the move account."""
    old_path = ctx.sabotaged("old-path")
    main_sampler = LockSampler(ctx.source)
    main_sampler.start()
    runs = 0
    try:
        if old_path:
            _grant_old_path(ctx)
        for _ in range(3 if old_path else 10):
            if old_path:
                old_path_dump(ctx)
            else:
                take_snapshot(ctx, "sampled.sql")
            runs += 1
    finally:
        if old_path:
            _revoke_old_path(ctx)
        main_sampler.finish()
    verdict = global_lock_verdict(main_sampler.rows)
    numbers = [
        f"{main_sampler.samples} samples of metadata_locks over {runs} {'old-path dump(s)' if old_path else 'snapshot(s)'}; "
        f"{main_sampler.table_lock_samples} saw a granted table lock",
        "lock kinds seen (object/lock/status): " + ", ".join("/".join(row) for row in sorted(main_sampler.rows)),
    ]
    # The ticket body's variant, recorded: LOCK INSTANCE FOR BACKUP.
    sampler = LockSampler(ctx.source)
    sampler.start()
    session = ctx.source.session(user=MOVER, password=ctx.passwords.mover)
    try:
        session.run("LOCK INSTANCE FOR BACKUP;")
        time.sleep(0.8)
        session.run("UNLOCK INSTANCE;")
    finally:
        session.close()
        sampler.finish()
    numbers.append("LOCK INSTANCE FOR BACKUP variant shows: " + ", ".join("/".join(row) for row in sorted(sampler.rows)))
    return ControlResult(3, "no GLOBAL metadata lock", verdict, numbers)


def control_4(ctx: Ctx) -> ControlResult:
    """Scoped grants: the account can neither read the other schema nor take FTWRL."""
    sabotage = ctx.sabotaged("reload-grant")
    if sabotage:
        ctx.source.run(f"GRANT RELOAD ON *.* TO '{MOVER}'@'localhost';")
    try:
        as_mover = {"user": MOVER, "password": ctx.passwords.mover, "check": False}
        other = ctx.source.run(f"SELECT * FROM {OTHER}.posts LIMIT 1;", **as_mover)
        ftwrl = ctx.source.run("FLUSH TABLES WITH READ LOCK; UNLOCK TABLES;", **as_mover)
        grants = [row[0] for row in ctx.source.query(f"SHOW GRANTS FOR '{MOVER}'@'localhost';")]
    finally:
        if sabotage:
            ctx.source.run(f"REVOKE RELOAD ON *.* FROM '{MOVER}'@'localhost';", check=False)
    plugins = [row[0] for row in ctx.source.query("SELECT PLUGIN_NAME FROM information_schema.PLUGINS WHERE PLUGIN_NAME LIKE '%clone%';")]
    privileges = parse_global_privileges(grants)
    errno_other, errno_ftwrl = parse_errno(other.stderr), parse_errno(ftwrl.stderr)
    verdict = scoped_grant_verdict(errno_other, errno_ftwrl, plugins, privileges)
    numbers = [
        f"read of {OTHER}.posts: error {errno_other}; FLUSH TABLES WITH READ LOCK: error {errno_ftwrl}",
        f"clone plugin rows in information_schema.PLUGINS: {len(plugins)}; global privileges: {sorted(privileges)}",
        f"FINDING: with the ticket body's grant list alone (SELECT on {BLOG}.* plus BACKUP_ADMIN), reading performance_schema.log_status "
        f"gives error {ctx.notes.get('log_status_errno_without_table_grant')}; the proof also grants SELECT on that one table",
        f"without BACKUP_ADMIN (SELECT and LOCK TABLES on {BLOG}.*, SELECT on log_status), reading log_status gives: "
        f"{ctx.texts.get('log_status_without_backup_admin', 'not recorded')}",
    ]
    return ControlResult(4, "scoped grants", verdict, numbers)


def control_5(ctx: Ctx) -> ControlResult:
    """The lock wait is bounded and the retry succeeds once the transaction ends."""
    sabotage = ctx.sabotaged("no-timeout")
    numbers = []
    limits = bs.Limits()
    if sabotage:
        limits = bs.Limits(lock_wait_timeout_seconds=31536000, wait_deadline_seconds=120.0, hold_bound_seconds=120.0)
        numbers.append("sabotage: no lock timeout (a year, the server's default) and no client deadline")

    # A. The server's own bound, observed directly: LOCK TABLES under an open
    # blog write transaction, with the lock_wait_timeout the limits set (a
    # year under no-timeout, so A goes red as well as B).
    holder = ctx.source.session(database=BLOG)
    holder.run("START TRANSACTION; INSERT INTO posts (title, slug, status, author_id) VALUES ('open-a', 'open-a', 'draft', 1);")
    release = threading.Thread(target=lambda: holder.run("DO SLEEP(3); COMMIT;"), daemon=True)
    release.start()
    direct = ctx.source.session(user=MOVER, password=ctx.passwords.mover)
    direct.run(f"SET SESSION lock_wait_timeout = {limits.lock_wait_timeout_seconds};")
    began_direct = time.monotonic()
    try:
        direct.run(bs.lock_tables_sql([(BLOG, "posts")]))
        direct_errno, direct_seconds = 0, time.monotonic() - began_direct
    except SessionEnded as ended:
        direct_errno, direct_seconds = parse_errno(ended.stderr), ended.elapsed
    release.join(timeout=30)
    holder.close()
    direct.close()
    numbers.append(f"direct: LOCK TABLES under an open write transaction gave error {direct_errno} after {direct_seconds:.2f} s")
    direct_ok = direct_errno == 1205 and abs(direct_seconds - bs.LOCK_WAIT_TIMEOUT_SECONDS) <= MEASUREMENT_MARGIN_SECONDS

    # B. The module under a 10 s open transaction, with a blog writer queued
    # behind every lock request it makes.
    # LOCK TABLES takes its table locks one at a time in name order, so which
    # writer queues depends on where its table falls: members is granted
    # before the wait on posts, settings is not yet requested. One writer on
    # each, plus the Ghost-like multi-table transaction.
    writers = {
        "posts": Writer(ctx.source, BLOG, blog_posts_statement, pause=0.01),
        "members": Writer(ctx.source, BLOG, blog_members_statement, pause=0.01),
        "settings": Writer(ctx.source, BLOG, blog_settings_statement, pause=0.01),
        "transaction": Writer(ctx.source, BLOG, blog_statement, pause=0.01),
    }
    for writer in writers.values():
        writer.start()
    time.sleep(1.0)
    holder = ctx.source.session(database=BLOG)
    holder.run("START TRANSACTION; INSERT INTO posts (title, slug, status, author_id) VALUES ('open-b', 'open-b', 'draft', 1);")
    opened = time.monotonic()
    committed: list[float] = []

    def hold_ten_seconds() -> None:
        holder.run("DO SLEEP(10); COMMIT;")
        committed.append(time.monotonic())

    release = threading.Thread(target=hold_ten_seconds, daemon=True)
    release.start()
    aborts: list[tuple[float, str]] = []
    try:
        report, _ = take_snapshot(
            ctx, "bounded.sql", limits=limits, log=lambda message: aborts.append((time.monotonic() - opened, message))
        )
        finished = time.monotonic()
    finally:
        release.join(timeout=60)
        holder.close()
        samples = {name: writer.finish() for name, writer in writers.items()}
    per_writer = {name: latencies_between(found, opened, finished) for name, found in samples.items()}
    waits = [wait for found in per_writer.values() for wait in found]
    wait_verdict = bounded_wait_verdict(waits, MODULE_WAIT_BOUND_SECONDS, BODY_WAIT_CEILING_SECONDS)
    retry = retry_verdict(report.aborted_attempts, report.attempts, bool(committed) and finished >= committed[0] - 0.05)
    deadline_verdict, deadline_numbers = client_deadline_case(ctx)
    failures = [v.reason for v in (wait_verdict, retry, deadline_verdict) if not v.passed]
    if not direct_ok:
        failures.append(f"the direct LOCK TABLES gave error {direct_errno} after {direct_seconds:.2f} s, not 1205 at about {bs.LOCK_WAIT_TIMEOUT_SECONDS} s")
    verdict = (
        Verdict(False, "; ".join(failures))
        if failures
        else Verdict(True, f"{wait_verdict.reason}; {retry.reason}; {deadline_verdict.reason}")
    )
    numbers += [
        f"module: {report.aborted_attempts} abort(s) then success at attempt {report.attempts}, "
        f"{finished - opened:.1f} s after the transaction opened; aborts at "
        + ", ".join(f"{at:.2f} s ({message.split(': ', 2)[-1]})" for at, message in aborts),
        f"{len(waits)} blog writer statements in the window; worst wait per writer: "
        + ", ".join(f"{name} {_ms(max(found, default=0.0))}" for name, found in per_writer.items()),
        f"{writers['transaction'].deadlocks} multi-table transactions rolled back as deadlock victims (error 1213)",
        "FINDING: " + deadlock_observation(ctx),
    ]
    numbers += deadline_numbers
    return ControlResult(5, "bounded lock wait", verdict, numbers)


def client_deadline_case(ctx: Ctx) -> tuple[Verdict, list[str]]:
    """Control 5, part C. Two blocked tables: LOCK TABLES is granted on
    `members` after 0.5 s and then waits on `posts`. The server gives each
    wait 1 s, so the client's 1.2 s deadline is the bound that fires first."""
    posts_hold = ctx.source.session(database=BLOG)
    posts_hold.run("START TRANSACTION; INSERT INTO posts (title, slug, status, author_id) VALUES ('open-c2', 'open-c2', 'draft', 1);")
    release_posts = threading.Thread(target=lambda: posts_hold.run("DO SLEEP(10); COMMIT;"), daemon=True)
    release_posts.start()
    members_hold = ctx.source.session(database=BLOG)
    members_hold.run("START TRANSACTION; " + blog_members_statement("open-c2", 1))
    limits = bs.Limits(wait_deadline_seconds=120.0) if ctx.sabotaged("no-deadline") else bs.Limits()
    messages: list[str] = []
    outcome: dict[str, object] = {}

    def snapshot() -> None:
        try:
            outcome["report"], _ = take_snapshot(ctx, "deadline.sql", limits=limits, log=messages.append)
        except Exception as exc:  # recorded as a failed verdict below, never raised
            outcome["error"] = exc

    worker = threading.Thread(target=snapshot, daemon=True)
    worker.start()
    pending_sql = (
        "SELECT COUNT(*) FROM performance_schema.metadata_locks ml JOIN performance_schema.threads t "
        f"ON t.THREAD_ID = ml.OWNER_THREAD_ID WHERE t.PROCESSLIST_USER = '{MOVER}' "
        "AND ml.LOCK_STATUS = 'PENDING' AND ml.OBJECT_NAME = 'members';"
    )
    pending = False
    for _ in range(100):
        if ctx.source.query(pending_sql)[0][0] != "0":
            pending = True
            break
        time.sleep(0.05)
    time.sleep(0.5)
    members_hold.run("COMMIT;")
    worker.join(timeout=60)
    release_posts.join(timeout=30)
    posts_hold.close()
    members_hold.close()
    if not pending:
        return Verdict(False, "the module's LOCK TABLES never queued on members: the two-table case was not set up"), []
    if "error" in outcome:
        return Verdict(False, f"no consistent snapshot in the two-table case: {outcome['error']}"), []
    report = outcome["report"]
    if not isinstance(report, bs.SnapshotReport):
        return Verdict(False, "the two-table case returned no report"), []
    first = next((message for message in messages if "aborted" in message), None)
    verdict = client_deadline_verdict(first, limits.wait_deadline_seconds)
    numbers = [
        f"two blocked tables: first abort {first!r}; {len(messages)} abort(s) in all, then attempt {report.attempts} succeeded"
    ]
    return verdict, numbers


def deadlock_observation(ctx: Ctx) -> str:
    """Recorded, not gated: a write transaction that has touched one blog
    table, then a second after LOCK TABLES is pending on both. The pending
    read lock queues the second statement; the first holds the lock the
    pending request waits for; the server resolves that as a deadlock."""
    victim = ctx.source.session(database=BLOG)
    victim.run("START TRANSACTION; INSERT INTO posts (title, slug, status, author_id) VALUES ('open-c', 'open-c', 'draft', 1);")
    locker = ctx.source.session(user=MOVER, password=ctx.passwords.mover)
    locker.run("SET SESSION lock_wait_timeout = 5;")
    granted = threading.Event()

    def request_lock() -> None:
        try:
            locker.run(bs.lock_tables_sql([(BLOG, table) for table in BLOG_TABLES]))
        except SessionEnded:
            return
        granted.set()

    thread = threading.Thread(target=request_lock, daemon=True)
    thread.start()
    pending_sql = (
        "SELECT COUNT(*) FROM performance_schema.metadata_locks ml JOIN performance_schema.threads t "
        f"ON t.THREAD_ID = ml.OWNER_THREAD_ID WHERE t.PROCESSLIST_USER = '{MOVER}' AND ml.LOCK_STATUS = 'PENDING';"
    )
    for _ in range(50):
        if ctx.source.query(pending_sql)[0][0] != "0":
            break
        time.sleep(0.1)
    else:
        victim.close()
        locker.close()
        return "the LOCK TABLES request never became pending, so the deadlock case was not observed"
    began = time.monotonic()
    try:
        victim.run("INSERT INTO emails (post_id, status) VALUES (1, 'pending');")
        errno = 0
        victim.run("COMMIT;")
    except SessionEnded as ended:
        errno = parse_errno(ended.stderr)
    elapsed = time.monotonic() - began
    thread.join(timeout=30)
    if granted.is_set():
        locker.run("UNLOCK TABLES;")
    victim.close()
    locker.close()
    return (
        f"a write transaction already holding blog.posts, then writing blog.emails while LOCK TABLES on all {len(BLOG_TABLES)} "
        f"blog tables was pending: error {errno} after {elapsed * 1000:.0f} ms"
        + (" (rolled back as the deadlock victim; the application must retry)" if errno == 1213 else "")
    )


def control_6(ctx: Ctx) -> ControlResult:
    """DDL behaviour while the ticket body's LOCK INSTANCE FOR BACKUP is held. A finding."""
    altered = Writer(ctx.source, OTHER, other_posts_statement, pause=0.01)
    sibling = Writer(ctx.source, OTHER, other_settings_statement, pause=0.01)
    blog = Writer(ctx.source, BLOG, blog_statement, pause=0.01)
    holder = ctx.source.session(user=MOVER, password=ctx.passwords.mover)
    ddl = ctx.source.session()
    for writer in (altered, sibling, blog):
        writer.start()
    try:
        time.sleep(1.5)
        holder.run("LOCK INSTANCE FOR BACKUP;")
        locked = time.monotonic()
        time.sleep(2.0)
        hold_only = (locked, time.monotonic())
        alter_began = time.monotonic()
        hold_seconds = 6.0
        remaining = hold_seconds - (alter_began - locked)
        unlock = threading.Timer(max(remaining, 0.0), lambda: holder.run("UNLOCK INSTANCE;"))
        unlock.start()
        ddl.run(f"ALTER TABLE {OTHER}.posts ADD COLUMN probe_col INT NULL;")
        alter_ended = time.monotonic()
        unlock.join(timeout=30)
        time.sleep(0.5)
        ddl.run(f"ALTER TABLE {OTHER}.posts DROP COLUMN probe_col;")
    finally:
        holder.close()
        ddl.close()
        samples = {name: w.finish() for name, w in (("altered", altered), ("sibling", sibling), ("blog", blog))}
    during_alter = (alter_began, alter_ended)
    finding = ddl_finding(
        alter_seconds=alter_ended - alter_began,
        hold_remaining_seconds=remaining,
        altered_table_worst=max(latencies_between(samples["altered"], *during_alter), default=0.0),
        other_table_worst=max(latencies_between(samples["sibling"], *during_alter), default=0.0),
        blog_worst=max(latencies_between(samples["blog"], *during_alter), default=0.0),
        hold_only_worst=max(
            (max(latencies_between(samples[name], *hold_only), default=0.0) for name in samples), default=0.0
        ),
    )
    return ControlResult(6, "DDL behaviour under LOCK INSTANCE FOR BACKUP (finding)", Verdict(True, finding.text), [])


CONTROLS: Mapping[int, Callable[[Ctx], ControlResult]] = {1: control_1, 2: control_2, 3: control_3, 4: control_4, 5: control_5, 6: control_6}


def refusal(names: Sequence[str], docker_host: str | None, context: Callable[[], str]) -> str | None:
    """Why `run` must not start, or None. `context` is asked last, so the
    other two refusals never make a docker call."""
    if docker_host:
        return "DOCKER_HOST is set; this proof runs only in the local Docker context"
    unprefixed = [name for name in names if not name.startswith(CONTAINER_PREFIX)]
    if unprefixed:
        return f"container names {unprefixed} lack the {CONTAINER_PREFIX!r} prefix, so they are not this proof's own"
    name = context()
    if name not in LOCAL_DOCKER_CONTEXTS:
        return f"Docker context {name!r} is not the local default or desktop-linux context"
    return None


def docker_context() -> str:
    """`docker context show`'s output, or '' when docker cannot say. The exit
    code is not read, as the shell wrapper's `|| true` does not read it."""
    try:
        result = subprocess.run(["docker", "context", "show"], capture_output=True, text=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip()


def run(args: argparse.Namespace) -> int:
    reason = refusal([args.source, args.replica], os.environ.get("DOCKER_HOST"), docker_context)
    if reason is not None:
        print(f"REFUSED: {reason}", file=sys.stderr)
        return EXIT_REFUSED
    workdir = pathlib.Path(args.workdir)
    ctx = Ctx(
        source=Server(args.source, (workdir / "root.pw").read_text().strip()),
        replica=Server(args.replica, (workdir / "root.pw").read_text().strip()),
        workdir=workdir,
        passwords=Passwords.read(workdir),
        sabotage=args.sabotage,
    )
    controls = [int(part) for part in args.controls.split()]
    if args.sabotage:
        if args.sabotage not in SABOTAGE_TARGETS:
            print(f"unknown SABOTAGE {args.sabotage!r}; known: {sorted(SABOTAGE_TARGETS)}", file=sys.stderr)
            return 64
        controls = [n for n in controls if n in SABOTAGE_TARGETS[args.sabotage]]
        if not controls:
            print(f"SABOTAGE {args.sabotage} targets controls {SABOTAGE_TARGETS[args.sabotage]}; none selected", file=sys.stderr)
            return 64
    seed(ctx)
    outcomes: dict[int, bool] = {}
    for number in controls:
        ctx.say(f"== control {number}" + (f" (sabotage: {args.sabotage})" if args.sabotage else ""))
        try:
            result = CONTROLS[number](ctx)
        except (ProofError, bs.SnapshotError, subprocess.TimeoutExpired) as exc:
            result = ControlResult(number, "did not complete", Verdict(False, f"{type(exc).__name__}: {exc}"), [])
        for line in result.numbers:
            ctx.say(f"  {line}")
        outcomes[number] = result.verdict.passed
        label = "FINDING" if number == 6 else ("PASS" if result.verdict.passed else ("RED" if args.sabotage else "FAIL"))
        ctx.say(f"{label} control {number}, {result.title}: {result.verdict.reason}")
    code = exit_code(outcomes, sabotaged=bool(args.sabotage))
    if code == EXIT_PASSED:
        ctx.say("ALL PASSED" + (f" (controls {args.controls})" if args.controls != "1 2 3 4 5 6" else ""))
    elif code == EXIT_RED:
        ctx.say(f"RED as expected under sabotage {args.sabotage}: the control sees the failure")
    elif code == EXIT_SABOTAGE_NOT_DETECTED:
        ctx.say(f"SABOTAGE NOT DETECTED: a control stayed green under {args.sabotage}")
    elif code == EXIT_OPTION_C_UNAVAILABLE:
        ctx.say("OPTION (c) UNAVAILABLE: a control from 1 to 5 failed on the pinned digest. Stop and tell the owner before any fallback.")
    else:
        ctx.say("the DDL finding (control 6) could not be recorded")
    return code


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run the verdict functions on canned red and green inputs")
    sub = parser.add_subparsers(dest="command")
    runner = sub.add_parser("run", help="run the controls against two running containers (prove-snapshot-locking.sh does this)")
    runner.add_argument("--source", required=True)
    runner.add_argument("--replica", required=True)
    runner.add_argument("--workdir", required=True)
    runner.add_argument("--controls", default="1 2 3 4 5 6")
    runner.add_argument("--sabotage", default=None)
    args = parser.parse_args(argv)
    if args.self_test:
        failed = self_test()
        for label in failed:
            print(f"SELF-TEST FAILED: {label}")
        print(f"self-test: {len(SELF_TEST_CASES) - len(failed)} of {len(SELF_TEST_CASES)} cases behaved")
        return 1 if failed else 0
    if args.command == "run":
        return run(args)
    parser.print_help()
    return 64


if __name__ == "__main__":
    sys.exit(main())

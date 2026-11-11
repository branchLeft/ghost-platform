#!/usr/bin/env python3
"""Scope a restore's binlog replay to one tenant's writes.

mysqlbinlog filters a row event on the table it targets but a DDL
(`Query`) event on the session's `USE`d database at the moment it ran --
opposite rules that can put an admin's DDL in the wrong tenant's extract.
The given binlog files must be sorted and contiguous, `--start-position`
applies only to the first file, and mysqlbinlog is always run with
`TZ=UTC` regardless of the host's own timezone.
See extract_tenant_binlog.md for the full mechanics.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime
from typing import Iterable, NamedTuple

import gtid_snapshot

# The exact comment mysqldump's `--source-data=2` writes: an *uncommented*
# `CHANGE MASTER TO` (`--source-data=1`) would execute against whatever
# --all-databases forbids running it against, which is why dump_nightly.py
# always uses =2 and this parser only ever looks for the commented form.
SOURCE_DATA_PATTERN = re.compile(
    r"^--\s*CHANGE MASTER TO MASTER_LOG_FILE='(?P<log_file>[^']+)',\s*MASTER_LOG_POS=(?P<position>\d+);\s*$"
)

# The nightly dump of db1 is taken one schema at a time, each section opening
# with its own resume point in this form (dump_nightly.section_comment). It is
# deliberately not the bare form above, so a reader that only knows the bare
# one finds none and refuses.
SECTION_RESUME_PATTERN = re.compile(
    r"^--\s*BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='(?P<log_file>[^']+)',\s*MASTER_LOG_POS=(?P<position>\d+);\s*$"
)

# A binlog's own on-disk name: some base ending in a dot, then mysqld's
# zero-padded numeric sequence. Matched against the filename only (never a
# directory prefix), so where the decrypted files happen to sit on disk
# never affects whether the sequence reads as contiguous.
BINLOG_SEQUENCE_PATTERN = re.compile(r"^(?P<base>.+\.)(?P<seq>\d+)$")

# mysqlbinlog's own per-event header comment, e.g.
# "#260923 11:22:09 server id 1  end_log_pos 1819 CRC32 0x7cce0723  Query
# thread_id=12 ...". A tab or run of spaces separates the CRC32 field from
# the event-type keyword, so both are accepted.
QUERY_EVENT_HEADER_PATTERN = re.compile(rb"^#\d{6}[^\n]*[ \t]Query[ \t]+thread_id=", re.MULTILINE)

# Same header shape, for a Rotate event -- emitted at the end of every
# binlog file mysqld has closed (never the file currently being written),
# carrying the timestamp of that rotation.
ROTATE_EVENT_PATTERN = re.compile(
    rb"^#(?P<yymmdd>\d{6})[ \t]+(?P<time>\d{1,2}:\d{2}:\d{2})[^\n]*[ \t]Rotate[ \t]", re.MULTILINE
)

# A line mysqlbinlog emits as session/positioning boilerplate around a
# Query event's real statement -- never the statement itself. Stripping
# these first is what isolates "BEGIN" from a real DDL statement without
# having to parse SQL.
_BOILERPLATE_LINE_PATTERN = re.compile(rb"^(SET |/\*!|use `|#)")

# The three statements a Query event carries only for the storage engine's
# own transaction bookkeeping, never as user-visible work -- excluded from
# the statement count named in count_tenant_events.
_TRANSACTION_BOUNDARY_STATEMENTS = (b"BEGIN", b"COMMIT", b"ROLLBACK")


class ExtractError(Exception):
    """A stage of the scoped-replay pipeline did not complete."""


def _child_env(**extra: str) -> dict[str, str]:
    """The minimal environment passed to every subprocess this module
    starts: `PATH` so the binary can be found, plus whatever the caller
    adds. `subprocess.run`'s `env=` replaces the child's environment
    wholesale rather than extending this process's own -- deliberately:
    this module runs against decrypted database contents, so nothing this
    process happens to have set belongs implicitly in that child's
    environment too."""
    return {"PATH": os.environ.get("PATH", ""), **extra}


def _match_resume_comment(line: str) -> tuple[str, int] | None:
    match = SOURCE_DATA_PATTERN.match(line)
    if match is None:
        return None
    return match.group("log_file"), int(match.group("position"))


def _declares_database(line: str, tenant_database: str) -> bool:
    """True for a `CREATE DATABASE ... \\`name\\`` or `USE \\`name\\`;` line
    naming exactly this tenant. mysqldump emits both, in that order, ahead
    of a database's own table definitions, for every database a
    `--databases`/`--all-databases` dump carries."""
    escaped = re.escape(tenant_database)
    return bool(
        re.match(r"^CREATE DATABASE\b.*`" + escaped + r"`", line)
        or re.match(r"^USE `" + escaped + r"`;\s*$", line)
    )


class _ResumeScanner:
    """One pass over a dump's lines, finding the recovery position that
    governs one database. The dump carries it in one of two forms: a single
    bare comment for the whole dump, or one section comment per dumped
    section, in which case the database takes the latest section comment
    before the line that declares it."""

    def __init__(self, tenant_database: str) -> None:
        self._tenant = tenant_database
        self.bare: tuple[str, int] | None = None
        self._section: tuple[str, int] | None = None
        self._first_section: tuple[str, int] | None = None
        self._sections_seen = False
        self.declared = False
        self.declared_in: tuple[str, int] | None = None

    def feed(self, line: str) -> None:
        if self.bare is None:
            self.bare = _match_resume_comment(line)
        section = SECTION_RESUME_PATTERN.match(line)
        if section is not None:
            self._section = (section.group("log_file"), int(section.group("position")))
            self._first_section = self._first_section or self._section
            self._sections_seen = True
        if not self.declared and _declares_database(line, self._tenant):
            self.declared = True
            self.declared_in = self._section

    def resume_point(self) -> tuple[str, int] | None:
        """The (file, position) that governs the database, or None if the dump
        carries no file and position at all. Raises if it carries both forms,
        or if the database sits in front of every section comment."""
        if self.bare is not None and self._sections_seen:
            raise ExtractError(
                "dump carries both a bare '-- CHANGE MASTER TO ...' comment and per-section resume points: "
                "the recovery position is ambiguous"
            )
        if not self._sections_seen:
            return self.bare
        if not self.declared:
            # No database to place: the caller refuses with the typo message.
            return self._first_section
        if self.declared_in is None:
            raise ExtractError(
                f"tenant database {self._tenant!r} is declared before any section resume point in the dump: "
                "the dump is malformed, and its position cannot be known"
            )
        return self.declared_in


def find_resume_point(lines: Iterable[str], *, tenant_database: str) -> tuple[str, int]:
    """Streams `lines` once -- a file handle or any other line iterator,
    never a string this caller must first hold whole in memory -- looking
    for the dump's resume point for the named tenant (one bare
    `--source-data=2` comment, or the section comment of the section that
    declares the tenant) and for a declaration of the tenant's database.
    Raises ExtractError naming whichever is missing once `lines` is
    exhausted: a `--tenant-database` typo that matches no database the dump
    actually declares is refused here, before a single mysqlbinlog call,
    rather than producing an extract that replays nothing while reporting
    success.
    """
    scanner = _ResumeScanner(tenant_database)
    for raw_line in lines:
        scanner.feed(raw_line.rstrip("\n"))
    resume = scanner.resume_point()
    if resume is None:
        raise ExtractError("dump has no '-- CHANGE MASTER TO ...' comment; was it taken with --source-data=2?")
    if not scanner.declared:
        raise ExtractError(
            f"tenant database {tenant_database!r} is not declared anywhere in the dump (no matching "
            "CREATE DATABASE/USE) -- check --tenant-database for a typo, or that this is the right dump"
        )
    return resume


class RecoveryStart(NamedTuple):
    """Where a replay starts: a binary-log file and position (a dump from
    db1's bounded snapshot) or a GTID set (a lock-free dump, whose set is
    exactly the transactions the dump holds). Exactly one form is set."""

    log_file: str | None
    position: int | None
    gtid_set: str | None


def find_recovery_start(lines: Iterable[str], *, tenant_database: str) -> RecoveryStart:
    """Streams `lines` once for the dump's recovery position, in whichever
    form it carries, and for the tenant's declaration. A dump with both forms
    or neither is refused: the position must be one thing, read from one
    place."""
    scanner = _ResumeScanner(tenant_database)
    gtid_scanner = gtid_snapshot.PurgedStatementScanner()
    for raw_line in lines:
        line = raw_line.rstrip("\n")
        scanner.feed(line)
        try:
            gtid_scanner.feed(line)
        except gtid_snapshot.GtidError as exc:
            raise ExtractError(str(exc)) from None
    try:
        gtid_position = gtid_scanner.require_position()
    except gtid_snapshot.NoGtidStatement:
        gtid_position = None
    except gtid_snapshot.GtidError as exc:
        raise ExtractError(str(exc)) from None
    comment = scanner.resume_point()
    if comment is not None and gtid_position is not None:
        raise ExtractError(
            "dump carries both a '-- CHANGE MASTER TO ...' comment and a GTID_PURGED statement: "
            "the recovery position is ambiguous"
        )
    if comment is None and gtid_position is None:
        raise ExtractError(
            "dump has no '-- CHANGE MASTER TO ...' comment; was it taken with --source-data=2? "
            "It has no GTID_PURGED statement either (--set-gtid-purged=ON)"
        )
    if not scanner.declared:
        raise ExtractError(
            f"tenant database {tenant_database!r} is not declared anywhere in the dump (no matching "
            "CREATE DATABASE/USE) -- check --tenant-database for a typo, or that this is the right dump"
        )
    if gtid_position is not None:
        return RecoveryStart(log_file=None, position=None, gtid_set=gtid_position)
    assert comment is not None
    return RecoveryStart(log_file=comment[0], position=comment[1], gtid_set=None)


def parse_dump_recovery_start(dump_text: str, *, tenant_database: str) -> RecoveryStart:
    return find_recovery_start(dump_text.splitlines(), tenant_database=tenant_database)


def read_dump_recovery_start(path: str, *, tenant_database: str) -> RecoveryStart:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return find_recovery_start(handle, tenant_database=tenant_database)


def parse_dump_resume_point(dump_text: str, *, tenant_database: str) -> tuple[str, int]:
    """String-based convenience wrapper over find_resume_point, for a
    caller that already holds the dump in memory. The CLI path (main(),
    via read_dump_resume_point) never does this for a dump of unknown
    size -- it streams the file directly."""
    return find_resume_point(dump_text.splitlines(), tenant_database=tenant_database)


def read_dump_resume_point(path: str, *, tenant_database: str) -> tuple[str, int]:
    """Streams the dump file straight off disk, one line at a time --
    never `handle.read()`, which would hold an arbitrarily large dump
    whole in memory just to find a handful of header lines near its top."""
    with open(path, encoding="utf-8", errors="replace") as handle:
        return find_resume_point(handle, tenant_database=tenant_database)


def _binlog_sequence(path: str) -> tuple[str, int]:
    name = path.rsplit("/", 1)[-1]
    match = BINLOG_SEQUENCE_PATTERN.match(name)
    if match is None:
        raise ExtractError(f"{path!r} does not look like a binlog filename (no numeric sequence suffix)")
    return match.group("base"), int(match.group("seq"))


def assert_contiguous(binlog_paths: list[str]) -> None:
    """Refuses a binlog file list with a gap -- same base name, sequence
    numbers not consecutive -- before a single mysqlbinlog call. A gap
    would under-replay silently: mysqlbinlog reads exactly the files it is
    given and has no way to notice one missing from between two others."""
    if len(binlog_paths) < 2:
        return
    prev_base, prev_seq = _binlog_sequence(binlog_paths[0])
    for path in binlog_paths[1:]:
        base, seq = _binlog_sequence(path)
        if base != prev_base:
            raise ExtractError(f"{path!r} does not share a base name with {binlog_paths[0]!r}")
        if seq != prev_seq + 1:
            raise ExtractError(
                f"binlog sequence has a gap after {prev_base}{prev_seq:06d}: next given file is "
                f"{path!r}, not {prev_base}{prev_seq + 1:06d} -- the replay would silently skip "
                "whatever that gap holds"
            )
        prev_base, prev_seq = base, seq


def sorted_binlog_paths(binlog_paths: list[str]) -> list[str]:
    """Sorts by binlog sequence number, independent of the order given.
    Slicing an *unsorted* list from the resume file's own index silently
    drops any file that sorts after the resume file but happens to appear
    earlier in the caller's list -- e.g. given as `000005 000004` with a
    resume file of `000004`, slicing from index 0 keeps only `000004` and
    drops `000005` with no error. Sorting first, then slicing, then
    checking contiguity over the whole sorted list closes that gap."""
    return sorted(binlog_paths, key=_binlog_sequence)


def mysqlbinlog_argv(
    binlog_paths: list[str],
    *,
    database: str | None,
    start_position: int | None = None,
    stop_datetime: str | None = None,
    exclude_gtids: str | None = None,
) -> list[str]:
    """Builds the mysqlbinlog invocation that scopes replay to one tenant.
    `database=None` builds the *unscoped* command, kept as a first-class
    option here rather than a separate code path to keep in sync.
    The replay starts at `start_position` (file and position) or, for a
    lock-free dump, skips every transaction in `exclude_gtids` (the dump's
    own GTID set); exactly one is given.
    See extract_tenant_binlog.md#mysqlbinlog_argv."""
    if not binlog_paths:
        raise ExtractError("at least one binlog file is required")
    if (start_position is None) == (exclude_gtids is None):
        raise ExtractError("exactly one of start_position or exclude_gtids must be given")
    if exclude_gtids is not None:
        argv = ["mysqlbinlog", f"--exclude-gtids={exclude_gtids}", "--skip-gtids"]
    else:
        argv = ["mysqlbinlog", f"--start-position={start_position}"]
    if database is not None:
        argv.append(f"--database={database}")
    if stop_datetime is not None:
        argv.append(f"--stop-datetime={stop_datetime}")
    argv.extend(binlog_paths)
    return argv


def _query_event_blocks(sql: bytes) -> list[bytes]:
    """Splits the extract into one slice per Query event, each running from
    just after that event's own header comment to just before the next
    event's header comment (of any type) or end of stream."""
    starts = [m.end() for m in QUERY_EVENT_HEADER_PATTERN.finditer(sql)]
    blocks = []
    for start in starts:
        line_end = sql.index(b"\n", start)
        next_header = sql.find(b"\n#", line_end)
        end = next_header if next_header != -1 else len(sql)
        blocks.append(sql[line_end + 1 : end])
    return blocks


def _is_transaction_boundary_only(block: bytes) -> bool:
    """True if, once every session/positioning boilerplate line is
    stripped, a Query event's block reduces to exactly BEGIN, COMMIT or
    ROLLBACK and nothing else -- the storage engine's own bookkeeping, not
    a statement a restore needs to reapply."""
    kept = [
        line.strip()
        for line in block.split(b"\n")
        if line.strip() and not _BOILERPLATE_LINE_PATTERN.match(line.strip())
    ]
    statement = b" ".join(kept).strip()
    return statement in _TRANSACTION_BOUNDARY_STATEMENTS


def count_tenant_events(sql: bytes, tenant_database: str) -> tuple[int, int]:
    """Returns (row_events, statements) attributed to `tenant_database`
    within an extract already scoped to it by `--database=<tenant_database>`.
    Never raises -- only reports what the extract contains.
    See extract_tenant_binlog.md#count_tenant_events."""
    row_pattern = re.compile(rb"Table_map:\s*`" + re.escape(tenant_database.encode()) + rb"`\.")
    row_events = len(row_pattern.findall(sql))
    statements = sum(1 for block in _query_event_blocks(sql) if not _is_transaction_boundary_only(block))
    return row_events, statements


def last_rotate_timestamp(sql: bytes) -> str | None:
    """Returns "YYYY-MM-DD HH:MM:SS" for the last Rotate event in the
    extract -- the moment mysqld closed the last binlog file given, i.e.
    where this replay's coverage actually ends -- run under `TZ=UTC` same
    as the rest of this module, so the value is UTC like everything else
    here. A Rotate event is never filtered by `--database`: it is
    structural, not tied to any database. None if no Rotate event is
    present, which happens only if the last file given is the one mysqld
    is still writing (ship_binlogs.py never ships that one, so this should
    not occur against files it produced) -- coverage cannot be determined
    from the extract in that case."""
    matches = list(ROTATE_EVENT_PATTERN.finditer(sql))
    if not matches:
        return None
    last = matches[-1]
    yymmdd = last.group("yymmdd").decode()
    time_part = last.group("time").decode()
    year = 2000 + int(yymmdd[0:2])
    month, day = yymmdd[2:4], yymmdd[4:6]
    hh, mm, ss = time_part.split(":")
    return f"{year:04d}-{month}-{day} {int(hh):02d}:{mm}:{ss}"


def binlogs_coverage_end(last_binlog_path: str, *, run=subprocess.run) -> str | None:
    """The coverage horizon of a binlog range: the closing Rotate of its
    last file, read by a separate unfiltered mysqlbinlog pass over that one
    file. The replay's own extract cannot supply it, because
    `--stop-datetime` stops before the stopping file's closing Rotate, so
    the last Rotate in a stop-limited extract belongs to an earlier file.
    None if the pass fails or the file has no Rotate (still open): the
    horizon is then unknown, never guessed, and the restore already applied
    is not failed over a missing diagnostic."""
    result = run(["mysqlbinlog", last_binlog_path], capture_output=True, check=False, env=_child_env(TZ="UTC"))
    if result.returncode != 0:
        return None
    return last_rotate_timestamp(result.stdout)


def parse_utc_datetime(text: str) -> datetime | None:
    """Parses the "YYYY-MM-DD HH:MM:SS" shape (hour may be unpadded) or its
    "T"-separated and date-only variants mysqlbinlog accepts. None if the
    text is none of these, so a comparison is skipped rather than guessed."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text.strip(), fmt)
        except ValueError:
            continue
    return None


def extract_tenant_stream(
    binlog_paths: list[str],
    *,
    database: str | None,
    start_position: int | None = None,
    stop_datetime: str | None = None,
    run=subprocess.run,
    exclude_gtids: str | None = None,
) -> bytes:
    """Returns the filtered SQL stream as bytes, whether or not it carries
    any event for `database` -- an empty (for this tenant) result is a
    legitimate outcome, not a failure; see tenant_wrote_anything and
    _replay_from_resume_point, which decides what to do with it. Raises
    ExtractError only on a non-zero mysqlbinlog exit: a partially filtered
    stream applied to a restore host is worse than none, so this never
    returns partial stdout on failure."""
    argv = mysqlbinlog_argv(
        binlog_paths,
        database=database,
        start_position=start_position,
        stop_datetime=stop_datetime,
        exclude_gtids=exclude_gtids,
    )
    result = run(argv, capture_output=True, check=False, env=_child_env(TZ="UTC"))
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace") if isinstance(result.stderr, bytes) else result.stderr
        raise ExtractError(f"mysqlbinlog exited {result.returncode}: {stderr}")
    return result.stdout


def apply_stream(
    sql: bytes,
    *,
    socket_path: str | None = None,
    host: str | None = None,
    user: str,
    password: str,
    run=subprocess.run,
) -> None:
    """Pipes the extracted stream into a `mysql` client against the restore
    target, the same `mysqlbinlog | mysql` shape Drill A already runs by
    hand. Exactly one of socket_path/host names the target -- a restore
    host is never the tenant database host itself, so there is no default
    to fall back on the way the timer scripts default to db1's socket."""
    if bool(socket_path) == bool(host):
        raise ExtractError("exactly one of socket_path or host must be given")
    argv = ["mysql"]
    if socket_path is not None:
        argv += ["--socket", socket_path]
    else:
        argv += ["--host", host]
    argv += ["--user", user]
    result = run(argv, input=sql, capture_output=True, check=False, env=_child_env(MYSQL_PWD=password))
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace") if isinstance(result.stderr, bytes) else result.stderr
        raise ExtractError(f"mysql exited {result.returncode} applying the extract: {stderr}")


class ReplayResult(NamedTuple):
    """The extract is always applied (see _replay_from_resume_point) --
    piping a boilerplate-only stream into `mysql` is harmless, so there is
    no "empty replay" branch to get wrong. `row_events` and `statements`
    (from count_tenant_events) say what that application actually did:
    both zero means nothing in the given range belonged to the tenant, a
    legitimate outcome main() reports as an empty replay rather than a
    failure. `binlogs_end_at` (from binlogs_coverage_end) is the given
    binlog range's own known coverage horizon, independent of whether the
    tenant wrote anything in it. `sql` is the bytes extract_tenant_stream
    produced and apply_stream applied."""

    row_events: int
    statements: int
    binlogs_end_at: str | None
    sql: bytes


def _replay_from_resume_point(
    *,
    log_file: str,
    position: int,
    binlog_paths: list[str],
    tenant_database: str,
    stop_datetime: str | None,
    apply_socket_path: str | None,
    apply_host: str | None,
    apply_user: str,
    apply_password: str,
    run,
) -> ReplayResult:
    # Sorted before the resume file is located: a caller's list is not
    # guaranteed ascending, and slicing from an unsorted list would risk
    # silently dropping a later file that happened to be given earlier
    # (sorted_binlog_paths's own docstring). Contiguity is then checked
    # over the *whole* sorted list, not just the slice from the resume
    # file forward, so a gap anywhere -- including one this replay would
    # never otherwise touch -- is refused rather than left for a later,
    # harder-to-diagnose under-replay.
    sorted_paths = sorted_binlog_paths(binlog_paths)
    assert_contiguous(sorted_paths)
    resume_index = next((i for i, p in enumerate(sorted_paths) if p.endswith(log_file)), None)
    if resume_index is None:
        raise ExtractError(f"resume point names {log_file!r}, not found among the given binlog files")
    ordered_paths = sorted_paths[resume_index:]

    sql = extract_tenant_stream(
        ordered_paths,
        database=tenant_database,
        start_position=position,
        stop_datetime=stop_datetime,
        run=run,
    )
    row_events, statements = count_tenant_events(sql, tenant_database)
    # Always applied -- a stream with zero row events and zero statements
    # for this tenant is only session setup and positioning commands, a
    # no-op against the restore target, and applying it is simpler and
    # more honest than a second code path that has to agree with the
    # count above about when to skip it.
    apply_stream(
        sql,
        socket_path=apply_socket_path,
        host=apply_host,
        user=apply_user,
        password=apply_password,
        run=run,
    )
    return ReplayResult(
        row_events=row_events,
        statements=statements,
        binlogs_end_at=binlogs_coverage_end(ordered_paths[-1], run=run),
        sql=sql,
    )


PREVIOUS_GTIDS_HEADER_PATTERN = re.compile(rb"^#[^\n]*[ \t]Previous-GTIDs[ \t]*$", re.MULTILINE)
_PREVIOUS_GTIDS_LINE_PATTERN = re.compile(rb"^# ([0-9a-fA-F][0-9a-fA-F:,\-]*)[ \t]*$")

# mysqlbinlog stops before the first event at or past this position. A
# binlog's Format_description and Previous_gtids events are its first two,
# a few hundred bytes in.
_PREVIOUS_GTIDS_STOP_POSITION = 4096


def parse_previous_gtids(sql: bytes) -> str | None:
    """The canonical GTID set of the `Previous-GTIDs` event in mysqlbinlog's
    output for one file: every transaction executed before that file began.
    An event with no set under it is the empty set. None if the output has no
    such event, which is what a binlog written with gtid_mode=OFF gives."""
    header = PREVIOUS_GTIDS_HEADER_PATTERN.search(sql)
    if header is None:
        return None
    lines = sql[header.end() :].split(b"\n")[1:]
    parts: list[str] = []
    for line in lines:
        match = _PREVIOUS_GTIDS_LINE_PATTERN.match(line)
        if match is None:
            break
        parts.append(match.group(1).decode())
    return gtid_snapshot.normalise_gtid_set("".join(parts))


def assert_binlogs_cover_gtid_set(first_binlog_path: str, dump_gtid_set: str, *, run=subprocess.run) -> None:
    """Refuses a replay whose binlog range starts too late for the dump's
    set. The transactions to replay are those in the log and not in the
    dump's set. Those from before the first file are exactly that file's
    Previous-GTIDs; if any is not in the dump's set, it is in neither the
    dump nor the files given, and the restore would silently lack it. A first
    file with no Previous-GTIDs event was not written with GTIDs, so
    `--exclude-gtids` could not honour the set at all."""
    result = run(
        ["mysqlbinlog", f"--stop-position={_PREVIOUS_GTIDS_STOP_POSITION}", first_binlog_path],
        capture_output=True,
        check=False,
        env=_child_env(TZ="UTC"),
    )
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace") if isinstance(result.stderr, bytes) else result.stderr
        raise ExtractError(f"mysqlbinlog exited {result.returncode} reading the first file's header: {stderr}")
    previous = parse_previous_gtids(result.stdout)
    if previous is None:
        raise ExtractError(
            f"{first_binlog_path!r} has no Previous-GTIDs event: it was not written with gtid_mode=ON, so the "
            "dump's GTID set cannot say which of its transactions to skip"
        )
    try:
        covered = gtid_snapshot.is_subset(gtid_snapshot.parse_gtid_set(previous), gtid_snapshot.parse_gtid_set(dump_gtid_set))
    except gtid_snapshot.GtidError as exc:
        raise ExtractError(str(exc)) from None
    if not covered:
        raise ExtractError(
            f"binlog gap: {first_binlog_path!r} begins after transactions {previous!r} that the dump's set "
            f"{dump_gtid_set!r} does not hold -- an earlier binlog file is missing from the list given, and "
            "the replay would silently lack what it holds"
        )


def _replay_from_gtid_set(
    *,
    gtid_set: str,
    binlog_paths: list[str],
    tenant_database: str,
    stop_datetime: str | None,
    apply_socket_path: str | None,
    apply_host: str | None,
    apply_user: str,
    apply_password: str,
    run,
    check_gap: bool = True,
) -> ReplayResult:
    """The replay for a lock-free dump: every file given, in order, with the
    dump's own set skipped. No file or position is involved, so no file is
    singled out: the gap check stands in for the resume file lookup."""
    sorted_paths = sorted_binlog_paths(binlog_paths)
    assert_contiguous(sorted_paths)
    if check_gap:
        assert_binlogs_cover_gtid_set(sorted_paths[0], gtid_set, run=run)
    sql = extract_tenant_stream(
        sorted_paths,
        database=tenant_database,
        exclude_gtids=gtid_set,
        stop_datetime=stop_datetime,
        run=run,
    )
    row_events, statements = count_tenant_events(sql, tenant_database)
    apply_stream(
        sql,
        socket_path=apply_socket_path,
        host=apply_host,
        user=apply_user,
        password=apply_password,
        run=run,
    )
    return ReplayResult(
        row_events=row_events,
        statements=statements,
        binlogs_end_at=binlogs_coverage_end(sorted_paths[-1], run=run),
        sql=sql,
    )


def replay_from_start(start: RecoveryStart, *, check_gap: bool = True, **replay) -> ReplayResult:
    """Replays from whichever position the dump carried. `replay` is the
    keyword arguments both replays share."""
    if start.gtid_set is not None:
        return _replay_from_gtid_set(gtid_set=start.gtid_set, check_gap=check_gap, **replay)
    assert start.log_file is not None and start.position is not None
    return _replay_from_resume_point(log_file=start.log_file, position=start.position, **replay)


def restore_point_in_time(
    *,
    dump_text: str,
    binlog_paths: list[str],
    tenant_database: str,
    stop_datetime: str | None = None,
    apply_socket_path: str | None = None,
    apply_host: str | None = None,
    apply_user: str,
    apply_password: str,
    run=subprocess.run,
    check_gap: bool = True,
) -> ReplayResult:
    """The end-to-end scoped replay: recovery position (and tenant-declaration
    check) from the dump, sort-then-contiguity check, filtered extract,
    always applied to the restore target (see ReplayResult)."""
    start = parse_dump_recovery_start(dump_text, tenant_database=tenant_database)
    return replay_from_start(
        start,
        check_gap=check_gap,
        binlog_paths=binlog_paths,
        tenant_database=tenant_database,
        stop_datetime=stop_datetime,
        apply_socket_path=apply_socket_path,
        apply_host=apply_host,
        apply_user=apply_user,
        apply_password=apply_password,
        run=run,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dump",
        required=True,
        help="Path to the decrypted dump: a --source-data=2 dump or a lock-free --set-gtid-purged=ON dump",
    )
    parser.add_argument(
        "--skip-gap-check",
        action="store_true",
        help="GTID dumps only: do not check that the first binlog file begins at or before the dump's GTID set. "
        "An operator override; a missing earlier file then goes unnoticed",
    )
    parser.add_argument("--tenant-database", required=True)
    parser.add_argument(
        "--stop-datetime",
        default=None,
        help='UTC, e.g. "2026-09-23 14:00:00" -- mysqlbinlog is run with TZ=UTC so this is never '
        "interpreted against the recovery host's own /etc/localtime",
    )
    parser.add_argument("--apply-socket", default=None)
    parser.add_argument("--apply-host", default=None)
    parser.add_argument("--apply-user", required=True)
    parser.add_argument("--apply-password-env", default="MYSQL_PWD", help="Env var holding the target password")
    parser.add_argument("binlog_paths", nargs="+", help="Decrypted binlog files, in binlog sequence order")
    args = parser.parse_args(argv)

    password = os.environ.get(args.apply_password_env)
    if not password:
        print(f"extract_tenant_binlog: {args.apply_password_env} must be set", file=sys.stderr)
        return 1

    try:
        start = read_dump_recovery_start(args.dump, tenant_database=args.tenant_database)
        if start.gtid_set is not None:
            print(f"extract_tenant_binlog: replaying after the dump's GTID set {start.gtid_set}")
            if args.skip_gap_check:
                print("extract_tenant_binlog: WARNING: --skip-gap-check given; a missing earlier binlog file will not be noticed", file=sys.stderr)
        result = replay_from_start(
            start,
            check_gap=not args.skip_gap_check,
            binlog_paths=args.binlog_paths,
            tenant_database=args.tenant_database,
            stop_datetime=args.stop_datetime,
            apply_socket_path=args.apply_socket,
            apply_host=args.apply_host,
            apply_user=args.apply_user,
            apply_password=password,
            run=subprocess.run,
        )
    except (ExtractError, OSError) as exc:
        print(f"extract_tenant_binlog: {exc}", file=sys.stderr)
        return 1
    if result.row_events == 0 and result.statements == 0:
        stop_label = args.stop_datetime if args.stop_datetime is not None else "end"
        print(
            f"extract_tenant_binlog: no {args.tenant_database} events between the resume point and "
            f"{stop_label}; the loaded dump is the restore"
        )
    else:
        print(
            f"extract_tenant_binlog: applied {result.row_events} row events and {result.statements} "
            f"statements for {args.tenant_database!r}"
        )
    if result.binlogs_end_at is not None:
        print(f"extract_tenant_binlog: the given binlogs end at {result.binlogs_end_at}")
        stop = parse_utc_datetime(args.stop_datetime) if args.stop_datetime is not None else None
        end = parse_utc_datetime(result.binlogs_end_at)
        if stop is not None and end is not None and stop > end:
            print(
                f"extract_tenant_binlog: WARNING: --stop-datetime {args.stop_datetime!r} is later than "
                f"the given binlogs' end ({result.binlogs_end_at}) -- a binlog covering the rest of the "
                "requested range may be missing from the given file list",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

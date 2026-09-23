#!/usr/bin/env python3
"""Scope a restore's binlog replay to one tenant's writes.

Every tenant on `db1` writes into the same physical binlog stream --
`ship_binlogs.py` ships it, and `dump_nightly.py` embeds the resume point a
replay starts from, but neither narrows the stream to one tenant. Replaying
it unfiltered onto a restore host, as the manual steps in
`db/RUNBOOK-db.md`'s Drill A do, brings every tenant's post-dump writes back
together -- which is the *instance*-level restore Doc 14 SS7.2 promises, not
the per-tenant one a "we deleted forty posts yesterday" recovery needs
without also reintroducing every other tenant's events since the dump.

`mysqlbinlog --database=<name>` is MySQL's own filter, and it draws the
line differently for the two event kinds this module cares about. A row
event (`Table_map`/`Write_rows`/...) is filtered on the table it actually
targets, never on which database a session had `USE`d: a write to
`tenant_a.posts` made from inside a `USE tenant_b` session is still a
`tenant_a` event and is kept when scoped to `tenant_a`. A DDL statement
(`ALTER`/`CREATE`/`DROP`/...) is logged as a `Query` event and is never a
row event even under ROW format -- mysqlbinlog filters it on the session's
own `USE`d database at the moment it ran, the older, coarser rule. So an
admin session that ran `USE tenant_b; ALTER TABLE tenant_a.posts ...` puts
that statement in *tenant_b*'s extract, not tenant_a's -- the reverse of a
row event's own rule -- and a DDL statement issued with no governing `USE`
at all is dropped from every tenant's extract. Ordinary tenant database
users cannot open a session against a database that is not their own, so
this only matters for an admin session run directly against `db1` --
`db/RUNBOOK-db.md` says so. ROW is MySQL 8.0's own server default, not
something `db/stack/compose.yml` sets -- this module relies on that default
rather than pinning it, which is a separate decision this story does not
make load-bearing.

`--start-position` applies only to the *first* file named on the command
line, per mysqlbinlog's own documented behaviour -- the dump's resume point
therefore only makes sense as the position within whichever binlog file was
open at dump time; every subsequent file in the replay set is read from its
own beginning. The given files are sorted by binlog sequence number before
any of this happens (a caller's order is not trusted to be ascending), and
the *whole* sorted list must be a contiguous binlog sequence with no gap --
a gap would under-replay silently, since mysqlbinlog reads exactly the
files it is given and has no way to notice one missing.

`mysqlbinlog` is not in the official `mysql` image (`db/RUNBOOK-db.md`'s
toolchain note); a pinned recovery image that carries it is tracked
separately and does not exist yet. This module assumes `mysqlbinlog` is
already on `PATH` wherever it runs and does not attempt to locate or
install it.

This module operates on binlog files already decrypted to plaintext, same
as the manual Drill A steps -- it never touches an `age`-encrypted object
or Object Storage directly.

The replay this drives is **not atomic**: a `mysqlbinlog | mysql` pipe can
fail partway through, between two binlog files or mid-transaction, leaving
the target in whatever state the events applied so far produced. Run it
only against a drained or scratch restore target nothing else is reading or
writing -- never against a database serving live traffic.

`mysqlbinlog`'s own `--stop-datetime` is evaluated against the *process's*
local time unless told otherwise: with no `TZ` in its environment, glibc
falls back to the recovery host's own `/etc/localtime`, not UTC and not
whatever timezone an operator's invoking shell happens to be in -- `env=`
below replaces the child's environment wholesale, so the invoking shell's
own `TZ` (if any) never reaches the child either way. This module always
runs `mysqlbinlog` with `TZ=UTC` explicitly set, so a recovery host
provisioned with any local timezone still interprets `--stop-datetime`
identically. Every timestamp this module's CLI takes is UTC.

The minimal environment below carries no `HOME`, so `mysql`'s default
`~/.my.cnf` lookup finds nothing -- deliberately: a personal or host
default file could otherwise silently add options (a different socket, a
different default database) to a replay applied against decrypted tenant
data. Nothing in this module reads `~/.my.cnf`.

The extract is always applied, whether or not it carries any event for the
tenant -- a stream of nothing but session setup is harmless to apply, and
there is no second code path to keep in sync with what gets counted (see
count_tenant_events). Every run also reports the given binlog range's own
coverage horizon: the last binlog file's closing `Rotate` event carries a
timestamp (last_rotate_timestamp), and main() warns on stderr when
`--stop-datetime` asks for an instant later than it -- the given file list
may be short a binlog. This is the only case a coverage gap can be told
apart from a tenant that genuinely wrote nothing: it has no bearing on the
row/statement counts themselves, which stay legitimately zero either way.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from typing import Iterable, NamedTuple

# The exact comment mysqldump's `--source-data=2` writes: an *uncommented*
# `CHANGE MASTER TO` (`--source-data=1`) would execute against whatever
# --all-databases forbids running it against, which is why dump_nightly.py
# always uses =2 and this parser only ever looks for the commented form.
SOURCE_DATA_PATTERN = re.compile(
    r"^--\s*CHANGE MASTER TO MASTER_LOG_FILE='(?P<log_file>[^']+)',\s*MASTER_LOG_POS=(?P<position>\d+);\s*$"
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


def find_resume_point(lines: Iterable[str], *, tenant_database: str) -> tuple[str, int]:
    """Streams `lines` once -- a file handle or any other line iterator,
    never a string this caller must first hold whole in memory -- looking
    for both the dump's `--source-data=2` resume comment and a declaration
    of the named tenant's database. Raises ExtractError naming whichever is
    missing once `lines` is exhausted: a `--tenant-database` typo that
    matches no database the dump actually carries is refused here, before
    a single mysqlbinlog call, rather than producing an extract that
    replays nothing while reporting success.
    """
    log_file: str | None = None
    position: int | None = None
    declared = False
    for raw_line in lines:
        line = raw_line.rstrip("\n")
        if log_file is None:
            found = _match_resume_comment(line)
            if found is not None:
                log_file, position = found
        if not declared and _declares_database(line, tenant_database):
            declared = True
    if log_file is None or position is None:
        raise ExtractError("dump has no '-- CHANGE MASTER TO ...' comment; was it taken with --source-data=2?")
    if not declared:
        raise ExtractError(
            f"tenant database {tenant_database!r} is not declared anywhere in the dump (no matching "
            "CREATE DATABASE/USE) -- check --tenant-database for a typo, or that this is the right dump"
        )
    return log_file, position


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
    start_position: int,
    stop_datetime: str | None = None,
) -> list[str]:
    """Builds the mysqlbinlog invocation that scopes replay to one tenant.

    `database=None` builds the *unscoped* command -- every tenant's events,
    exactly Drill A's existing manual step -- kept as a first-class option
    here (not a separate code path) so a sabotage of the filter and a
    restoration of it are the same one-line change to a caller, not two
    different functions to keep in sync. `stop_datetime`, like every
    timestamp this module takes, is UTC -- see extract_tenant_stream for
    the `TZ=UTC` environment that makes that true of mysqlbinlog's own
    interpretation of it, not just this module's documentation of it.
    """
    if not binlog_paths:
        raise ExtractError("at least one binlog file is required")
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

    row_events counts `Table_map` annotations naming the tenant --
    mysqlbinlog's own per-row-event marker, not a guess.

    statements counts Query events other than a bare BEGIN, COMMIT or
    ROLLBACK: DDL (`ALTER`/`CREATE`/`DROP`/...) is logged as a Query event
    even under ROW format and never appears as a Table_map/row event, so a
    row-event-only check misses a tenant whose only post-dump events were
    schema changes entirely -- exactly the shape of a restore that silently
    restored less while reporting success (R4).

    Neither count being nonzero does not mean the tenant is a typo; that is
    find_resume_point's job (the dump-declaration check). This function
    only reports what the extract contains, and never raises."""
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


def extract_tenant_stream(
    binlog_paths: list[str],
    *,
    database: str | None,
    start_position: int,
    stop_datetime: str | None = None,
    run=subprocess.run,
) -> bytes:
    """Returns the filtered SQL stream as bytes, whether or not it carries
    any event for `database` -- an empty (for this tenant) result is a
    legitimate outcome, not a failure; see tenant_wrote_anything and
    _replay_from_resume_point, which decides what to do with it. Raises
    ExtractError only on a non-zero mysqlbinlog exit: a partially filtered
    stream applied to a restore host is worse than none, so this never
    returns partial stdout on failure."""
    argv = mysqlbinlog_argv(
        binlog_paths, database=database, start_position=start_position, stop_datetime=stop_datetime
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
    failure. `binlogs_end_at` (from last_rotate_timestamp) is the given
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
        row_events=row_events, statements=statements, binlogs_end_at=last_rotate_timestamp(sql), sql=sql
    )


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
) -> ReplayResult:
    """The end-to-end scoped replay: resume point (and tenant-declaration
    check) from the dump, sort-then-contiguity check, filtered extract,
    always applied to the restore target (see ReplayResult)."""
    log_file, position = parse_dump_resume_point(dump_text, tenant_database=tenant_database)
    return _replay_from_resume_point(
        log_file=log_file,
        position=position,
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
    parser.add_argument("--dump", required=True, help="Path to the decrypted --source-data=2 dump")
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
        log_file, position = read_dump_resume_point(args.dump, tenant_database=args.tenant_database)
        result = _replay_from_resume_point(
            log_file=log_file,
            position=position,
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
        if args.stop_datetime is not None and args.stop_datetime > result.binlogs_end_at:
            print(
                f"extract_tenant_binlog: WARNING: --stop-datetime {args.stop_datetime!r} is later than "
                f"the given binlogs' end ({result.binlogs_end_at}) -- a binlog covering the rest of the "
                "requested range may be missing from the given file list",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

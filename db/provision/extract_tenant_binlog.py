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

`mysqlbinlog --database=<name>` is MySQL's own row-event filter. For a
row-format binlog it filters on each row event's own Table_map -- the
database and table the write actually targets -- never on which database a
session had `USE`d when the write was issued; a write to `tenant_a.posts`
made from inside a `USE tenant_b` session is still a `tenant_a` event and is
kept when scoped to `tenant_a`. ROW is MySQL 8.0's own server default, not
something `db/stack/compose.yml` sets -- this module relies on that default
rather than pinning it, which is a separate decision this story does not
make load-bearing.

`--start-position` applies only to the *first* file named on the command
line, per mysqlbinlog's own documented behaviour -- the dump's resume point
therefore only makes sense as the position within whichever binlog file was
open at dump time; every subsequent file in the replay set is read from its
own beginning, and the given file list must be the *contiguous* binlog
sequence from the resume file forward -- a gap would under-replay silently,
since mysqlbinlog reads exactly the files it is given and has no way to
notice an absent one.

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

`mysqlbinlog`'s own `--stop-datetime` is evaluated in the *process's* local
timezone unless told otherwise, not the server's and not UTC. This module
always runs it with `TZ=UTC` in its (otherwise minimal) environment, and
every timestamp this module's CLI takes -- `--stop-datetime` -- is UTC.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from typing import Iterable

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


def _has_table_map_event(sql: bytes, tenant_database: str) -> bool:
    """True if the extracted stream carries at least one row event whose
    Table_map names this tenant's database -- mysqlbinlog's own per-event
    annotation, not a guess. A scoped extract with none is not a smaller
    result, it is a no-op: every session/positioning wrapper statement is
    still emitted even when nothing in the requested database matched, so
    a byte count alone cannot tell a real (if small) replay from an empty
    one."""
    pattern = re.compile(rb"Table_map:\s*`" + re.escape(tenant_database.encode()) + rb"`\.")
    return pattern.search(sql) is not None


def extract_tenant_stream(
    binlog_paths: list[str],
    *,
    database: str | None,
    start_position: int,
    stop_datetime: str | None = None,
    run=subprocess.run,
) -> bytes:
    """Returns the filtered SQL stream as bytes. Raises ExtractError on any
    non-zero mysqlbinlog exit -- a partially filtered stream applied to a
    restore host is worse than none, so this never returns partial stdout
    on failure -- and, when `database` is given, also when the result
    carries no event for that database at all (see _has_table_map_event):
    a wrong --tenant-database must fail loudly, not apply nothing while
    reporting success."""
    argv = mysqlbinlog_argv(
        binlog_paths, database=database, start_position=start_position, stop_datetime=stop_datetime
    )
    result = run(argv, capture_output=True, check=False, env=_child_env(TZ="UTC"))
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace") if isinstance(result.stderr, bytes) else result.stderr
        raise ExtractError(f"mysqlbinlog exited {result.returncode}: {stderr}")
    sql = result.stdout
    if database is not None and not _has_table_map_event(sql, database):
        raise ExtractError(
            f"no Table_map event for tenant database {database!r} in the given binlog range -- nothing "
            "would be replayed; check --tenant-database for a typo and that the binlog files cover the "
            "range the tenant actually wrote in"
        )
    return sql


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
) -> bytes:
    resume_index = next((i for i, p in enumerate(binlog_paths) if p.endswith(log_file)), None)
    if resume_index is None:
        raise ExtractError(f"resume point names {log_file!r}, not found among the given binlog files")
    ordered_paths = binlog_paths[resume_index:]
    assert_contiguous(ordered_paths)

    sql = extract_tenant_stream(
        ordered_paths,
        database=tenant_database,
        start_position=position,
        stop_datetime=stop_datetime,
        run=run,
    )
    apply_stream(
        sql,
        socket_path=apply_socket_path,
        host=apply_host,
        user=apply_user,
        password=apply_password,
        run=run,
    )
    return sql


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
) -> bytes:
    """The end-to-end scoped replay: resume point (and tenant-declaration
    check) from the dump, contiguity check, filtered extract, applied to
    the restore target. Returns the bytes applied."""
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
        "interpreted in the operator's own local timezone",
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
        sql = _replay_from_resume_point(
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
    print(f"extract_tenant_binlog: applied {len(sql)} byte(s) scoped to {args.tenant_database!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

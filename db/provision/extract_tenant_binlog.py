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

`mysqlbinlog --database=<name>` is MySQL's own row-event filter, not a text
match on the SQL a statement-based binlog would contain: for a
row-format binlog (`db/stack/compose.yml`'s default) it keeps only the
row-image events whose originating `USE`d database matches, which is what
makes the filter exact rather than a heuristic over reconstructed SQL text.

`--start-position` applies only to the *first* file named on the command
line, per mysqlbinlog's own documented behaviour -- the dump's resume point
therefore only makes sense as the position within whichever binlog file was
open at dump time; every subsequent file in the replay set is read from its
own beginning.

`mysqlbinlog` ships in the pinned recovery image, not in the official
`mysql` image (`db/RUNBOOK-db.md`'s toolchain note) -- this module assumes
it is already on `PATH` wherever it runs and does not attempt to locate or
install it.

This module operates on binlog files already decrypted to plaintext, same
as the manual Drill A steps -- it never touches an `age`-encrypted object
or Object Storage directly.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

# The exact comment mysqldump's `--source-data=2` writes: an *uncommented*
# `CHANGE MASTER TO` (`--source-data=1`) would execute against whatever
# --all-databases forbids running it against, which is why dump_nightly.py
# always uses =2 and this parser only ever looks for the commented form.
SOURCE_DATA_PATTERN = re.compile(
    r"^--\s*CHANGE MASTER TO MASTER_LOG_FILE='(?P<log_file>[^']+)',\s*MASTER_LOG_POS=(?P<position>\d+);\s*$",
    re.MULTILINE,
)


class ExtractError(Exception):
    """A stage of the scoped-replay pipeline did not complete."""


def parse_dump_resume_point(dump_text: str) -> tuple[str, int]:
    """Reads the binlog file and position a `--source-data=2` dump recorded
    at the moment it started -- the same comment `db/RUNBOOK-db.md`'s Drill A
    has an operator find and copy out by hand. Raises ExtractError if the
    dump carries none, which means it was not taken with `--source-data=2`
    and has no resume point to replay from at all."""
    match = SOURCE_DATA_PATTERN.search(dump_text)
    if match is None:
        raise ExtractError("dump has no '-- CHANGE MASTER TO ...' comment; was it taken with --source-data=2?")
    return match.group("log_file"), int(match.group("position"))


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
    different functions to keep in sync.
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


def extract_tenant_stream(
    binlog_paths: list[str],
    *,
    database: str | None,
    start_position: int,
    stop_datetime: str | None = None,
    run=subprocess.run,
) -> bytes:
    """Returns the filtered SQL stream as bytes. Raises ExtractError on any
    non-zero exit -- a partially filtered stream applied to a restore host
    is worse than none, so this never returns partial stdout on failure."""
    argv = mysqlbinlog_argv(
        binlog_paths, database=database, start_position=start_position, stop_datetime=stop_datetime
    )
    result = run(argv, capture_output=True, check=False)
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
    result = run(argv, input=sql, env={"MYSQL_PWD": password}, capture_output=True, check=False)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace") if isinstance(result.stderr, bytes) else result.stderr
        raise ExtractError(f"mysql exited {result.returncode} applying the extract: {stderr}")


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
    """The end-to-end scoped replay: resume point from the dump, filtered
    extract, applied to the restore target. Returns the bytes applied, so a
    caller can log the extract size the way the design spike's own proof
    run did -- a byte count is cheap corroborating evidence that the filter
    did something rather than passing every event through unchanged."""
    log_file, position = parse_dump_resume_point(dump_text)
    # start_position only binds the first file named; every path from the
    # resume file onward must be given in binlog sequence order for a
    # replay spanning a rotation to read cleanly. A binlog rotated before
    # the resume file is entirely pre-dump and is dropped rather than sent
    # to mysqlbinlog unfiltered by position.
    resume_index = next((i for i, p in enumerate(binlog_paths) if p.endswith(log_file)), None)
    if resume_index is None:
        raise ExtractError(f"resume point names {log_file!r}, not found among the given binlog files")
    ordered_paths = binlog_paths[resume_index:]

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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", required=True, help="Path to the decrypted --source-data=2 dump")
    parser.add_argument("--tenant-database", required=True)
    parser.add_argument("--stop-datetime", default=None, help='e.g. "2026-09-23 14:00:00"')
    parser.add_argument("--apply-socket", default=None)
    parser.add_argument("--apply-host", default=None)
    parser.add_argument("--apply-user", required=True)
    parser.add_argument("--apply-password-env", default="MYSQL_PWD", help="Env var holding the target password")
    parser.add_argument("binlog_paths", nargs="+", help="Decrypted binlog files, in binlog sequence order")
    args = parser.parse_args(argv)

    import os

    password = os.environ.get(args.apply_password_env)
    if not password:
        print(f"extract_tenant_binlog: {args.apply_password_env} must be set", file=sys.stderr)
        return 1

    try:
        with open(args.dump, encoding="utf-8", errors="replace") as handle:
            dump_text = handle.read()
        sql = restore_point_in_time(
            dump_text=dump_text,
            binlog_paths=args.binlog_paths,
            tenant_database=args.tenant_database,
            stop_datetime=args.stop_datetime,
            apply_socket_path=args.apply_socket,
            apply_host=args.apply_host,
            apply_user=args.apply_user,
            apply_password=password,
        )
    except (ExtractError, OSError) as exc:
        print(f"extract_tenant_binlog: {exc}", file=sys.stderr)
        return 1
    print(f"extract_tenant_binlog: applied {len(sql)} byte(s) scoped to {args.tenant_database!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""One tenant's logical dump, streamed to stdout, taken with no credential
that could reach where a dump ends up.

The same operation invoked at a different moment (on-demand or the nightly
loop's one step), never a second code path, and with no object-storage
credential, encryption key, bucket, endpoint or region readable here --
encryption and the write to storage happen where the worker pulls to.
See dump_tenant.md for the connection model, the floor-check design and
why `posts` is excluded from it.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

from naming import (
    InvalidTenantName,
    database_and_user_name,
    sql_identifier,
    validate_tenant_name,
)

DUMP_MYSQL_USER = "backup"

# The socket bind-mounted out of the mysql container by db/stack/compose.yml,
# reachable from the bare host at this path once the stack is copied to
# /opt/branchleft/db per db/RUNBOOK-db.md.
DEFAULT_SOCKET = "/opt/branchleft/db/run/mysqld/mysqld.sock"

# `users` can never legitimately reach zero (Ghost refuses to delete the
# last account) and `settings` is seeded on every install and never
# wholesale-truncated. `posts` is excluded: "delete all content" empties it
# through the ordinary admin API, so a zero count there is not evidence of
# anything broken.
FLOOR_TABLES = ("users", "settings")

# Everything a mysql/mysqldump child process is allowed to see. PATH so the
# binary can be found by name; MYSQL_PWD is added per call, never here,
# because it is a value rather than a fixed name.
CHILD_ENV_ALLOWLIST = ("PATH",)

# Prefixes that name a storage or encryption credential anywhere in this
# estate's convention (AWS_* for Hetzner/S3-compatible keys, DB_BACKUP_* for
# the bucket/endpoint/region trio, AGE_* for the recipient key). This host
# must never see one, regardless of whether anything here would forward it.
FORBIDDEN_ENV_PREFIXES = ("AWS_", "DB_BACKUP_", "AGE_")


class DumpError(Exception):
    """A stage of the pipeline did not complete."""


class FloorError(DumpError):
    """A table that must never be empty was, so no dump was taken."""


def assert_no_storage_credential_in_environment() -> None:
    """Refuses to start rather than silently carry on with a storage or
    encryption variable already present in this process's own environment --
    the child-process allowlist below exists as a second, independent
    barrier, not as the only one."""
    present = sorted(name for name in os.environ if name.startswith(FORBIDDEN_ENV_PREFIXES))
    if present:
        raise DumpError(
            "refusing to start: this process's own environment carries "
            f"{', '.join(present)} -- the tenant database host must hold no "
            "credential that could reach where a dump ends up"
        )


def _child_env(password: str) -> dict[str, str]:
    env = {name: os.environ[name] for name in CHILD_ENV_ALLOWLIST if name in os.environ}
    env["MYSQL_PWD"] = password
    return env


def _run_mysql(sql: str, *, socket_path: str, password: str, run) -> str:
    result = run(
        ["mysql", "--socket", socket_path, "--user", DUMP_MYSQL_USER, "-N", "-B", "-e", sql],
        env=_child_env(password),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise DumpError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def check_floor(*, socket_path: str, db_name: str, password: str, run=subprocess.run) -> dict[str, int]:
    """The early refusal, against the live source. Returns the row count
    read for each floor table. Raises FloorError naming every one found
    empty, without ever invoking mysqldump -- but a pass here proves only
    that the source was not empty a moment ago, never what mysqldump itself
    goes on to capture."""
    counts: dict[str, int] = {}
    for table in FLOOR_TABLES:
        # db_name and table are both drawn from validated, fixed sources
        # (validate_tenant_name's charset and the FLOOR_TABLES constant), so
        # this interpolation carries no value a caller chose freely.
        out = _run_mysql(
            f"SELECT COUNT(*) FROM `{db_name}`.`{table}`;",
            socket_path=socket_path,
            password=password,
            run=run,
        )
        try:
            counts[table] = int(out.strip())
        except ValueError:
            raise FloorError(f"{db_name}: unreadable row count for `{table}`: {out!r}") from None

    empty = sorted(table for table, count in counts.items() if count == 0)
    if empty:
        raise FloorError(
            f"{db_name}: floor table(s) empty on the source ({', '.join(empty)}) -- refusing "
            "to take a dump before mysqldump has even run"
        )
    return counts


def run_mysqldump(*, socket_path: str, password: str, db_name: str, stdout, popen=subprocess.Popen) -> set[str]:
    """The floor check that actually matters: streams mysqldump's stdout,
    watching for an `INSERT` naming each floor table -- proof against what
    the dump actually wrote, not the source it read from. Returns the set
    of floor tables seen. See dump_tenant.md#floor-check."""
    patterns = {table: f"INSERT INTO `{table}` VALUES".encode() for table in FLOOR_TABLES}
    seen: set[str] = set()

    with tempfile.TemporaryFile() as stderr_file:
        process = popen(
            [
                "mysqldump",
                "--socket",
                socket_path,
                "--user",
                DUMP_MYSQL_USER,
                "--single-transaction",
                "--source-data=2",
                "--routines",
                "--triggers",
                "--set-gtid-purged=OFF",
                "--databases",
                db_name,
            ],
            env=_child_env(password),
            stdout=subprocess.PIPE,
            stderr=stderr_file,
        )
        try:
            for line in process.stdout:
                stdout.write(line)
                for table, pattern in patterns.items():
                    if table not in seen and line.startswith(pattern):
                        seen.add(table)
        finally:
            process.stdout.close()

        returncode = process.wait()
        if returncode != 0:
            stderr_file.seek(0)
            stderr_bytes = stderr_file.read()
            raise DumpError(f"mysqldump exited {returncode}: {stderr_bytes.decode(errors='replace')}")

    missing = sorted(table for table in FLOOR_TABLES if table not in seen)
    if missing:
        raise FloorError(
            f"{db_name}: floor table(s) had no INSERT statement in the dump itself "
            f"({', '.join(missing)}) -- the stream just written restores cleanly and "
            "contains nothing for them"
        )
    return seen


def run_dump(
    *,
    tenant_name: str,
    socket_path: str,
    password: str,
    stdout,
    run=subprocess.run,
    popen=subprocess.Popen,
) -> str:
    """Returns the database name dumped on success; raises InvalidTenantName
    or DumpError (FloorError included) otherwise. Nothing here accepts, reads
    or forwards a storage or encryption credential of any kind."""
    assert_no_storage_credential_in_environment()
    validate_tenant_name(tenant_name)
    db_name = database_and_user_name(sql_identifier(tenant_name))

    check_floor(socket_path=socket_path, db_name=db_name, password=password, run=run)
    run_mysqldump(socket_path=socket_path, password=password, db_name=db_name, stdout=stdout, popen=popen)
    return db_name


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise DumpError(f"{name} must be set")
    return value


def main(argv: list[str], *, run=subprocess.run, popen=subprocess.Popen, stdout=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tenant_name", help="the tenant slug, e.g. 'blog' for database ghost_blog")
    parser.add_argument("--socket", dest="socket_path", default=DEFAULT_SOCKET)
    args = parser.parse_args(argv)

    stdout = stdout if stdout is not None else sys.stdout.buffer

    try:
        password = _require_env("DB_DUMP_MYSQL_PWD")
        db_name = run_dump(
            tenant_name=args.tenant_name,
            socket_path=args.socket_path,
            password=password,
            stdout=stdout,
            run=run,
            popen=popen,
        )
    except (InvalidTenantName, DumpError) as exc:
        print(f"dump_tenant: {exc}", file=sys.stderr)
        return 1

    print(f"dump_tenant: wrote {db_name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

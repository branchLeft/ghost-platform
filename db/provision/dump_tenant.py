#!/usr/bin/env python3
"""One tenant's logical dump, streamed to stdout, taken with no credential
that could reach where a dump ends up.

Invoked for a single named tenant -- by hand, or by the backup worker
dialling into the database host and reading this process's stdout -- rather
than run on a schedule against every database in turn. That is what makes it
usable both as the nightly per-tenant loop's one step and as the on-demand
dump the upgrade ring needs before a bump: the same operation, invoked at a
different moment, never a second code path.

Connects over the Unix socket bind-mounted out of the mysql container
(`./run/mysqld:/var/run/mysqld` in db/stack/compose.yml) as the dedicated
`backup`@`localhost` account -- never TCP, so this never depends on
`bind-address` covering a loopback or private address for this account.
Reads only `DB_DUMP_MYSQL_PWD` from the environment -- /etc/branchleft/db.env
via whichever unit or session invokes this. There is no object-storage
credential, no encryption key and no bucket, endpoint or region to read: the
tenant database host is not the place either is meant to exist. Encryption
and the write to storage both happen where the worker pulls to, never here.

The dump's own stdout carries nothing but the dump: every status line this
script prints goes to stderr, because a caller reading stdout as the backup
payload cannot tell a trailing line of prose from the last bytes of a
`mysqldump` footer.

The floor check runs before `mysqldump` is invoked at all, against the same
tables a Ghost install always seeds on first boot. A tenant whose `users` or
`posts` table is empty was never actually initialised, and letting
`mysqldump` run anyway would produce a dump that decrypts cleanly, restores
cleanly, and captures nothing -- exactly the outcome a floor check exists to
refuse before it is written anywhere, not to discover afterwards.

`--databases <name>`, not `--all-databases`: one tenant's database per
invocation is what makes a tenant's failure local to that tenant rather than
aborting whatever else the caller was in the middle of dumping. `db1`'s own
`dump_nightly.py` is untouched by this file and keeps running exactly as it
does today.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

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

# A fresh Ghost install always seeds an owner account and an example post on
# first boot, so a genuine tenant's database can never have zero rows in
# either table -- zero here means the database was never initialised, not
# that a real tenant happens to have no content yet.
FLOOR_TABLES = ("users", "posts")


class DumpError(Exception):
    """A stage of the pipeline did not complete."""


class FloorError(DumpError):
    """A table that must never be empty was, so no dump was taken."""


def _run_mysql(sql: str, *, socket_path: str, password: str, run) -> str:
    result = run(
        ["mysql", "--socket", socket_path, "--user", DUMP_MYSQL_USER, "-N", "-B", "-e", sql],
        env={**os.environ, "MYSQL_PWD": password},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise DumpError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def check_floor(*, socket_path: str, db_name: str, password: str, run=subprocess.run) -> dict[str, int]:
    """Returns the row count read for each floor table. Raises FloorError
    naming every one found empty, without ever invoking mysqldump."""
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
            f"{db_name}: floor table(s) empty ({', '.join(empty)}) -- refusing to take a "
            "dump that would restore cleanly and capture nothing"
        )
    return counts


def run_mysqldump(*, socket_path: str, password: str, db_name: str, stdout, run=subprocess.run) -> None:
    result = run(
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
        env={**os.environ, "MYSQL_PWD": password},
        stdout=stdout,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise DumpError(f"mysqldump exited {result.returncode}: {result.stderr.decode(errors='replace')}")


def run_dump(
    *,
    tenant_name: str,
    socket_path: str,
    password: str,
    stdout,
    run=subprocess.run,
) -> str:
    """Returns the database name dumped on success; raises InvalidTenantName
    or DumpError (FloorError included) otherwise. Nothing here accepts, reads
    or forwards a storage or encryption credential of any kind."""
    validate_tenant_name(tenant_name)
    db_name = database_and_user_name(sql_identifier(tenant_name))

    check_floor(socket_path=socket_path, db_name=db_name, password=password, run=run)
    run_mysqldump(socket_path=socket_path, password=password, db_name=db_name, stdout=stdout, run=run)
    return db_name


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise DumpError(f"{name} must be set (see /etc/branchleft/db.env)")
    return value


def main(argv: list[str], *, run=subprocess.run, stdout=None) -> int:
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
        )
    except (InvalidTenantName, DumpError) as exc:
        print(f"dump_tenant: {exc}", file=sys.stderr)
        return 1

    print(f"dump_tenant: wrote {db_name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

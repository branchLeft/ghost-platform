#!/usr/bin/env python3
"""Idempotent create of one tenant's database, dedicated user and grants.

Run by hand on db1 (as root, once per tenant): MYSQL_PWD=...
provision_tenant_db.py --admin-user root <tenant>. Connects over the Unix
socket, never TCP, since root only ever exists as 'root'@'localhost'; safe
to re-run, since CREATE USER IF NOT EXISTS leaves an existing password
untouched.
See provision_tenant_db.md for the full reasoning.
"""

from __future__ import annotations

import argparse
import os
import secrets
import subprocess
import sys

from naming import (
    TENANT_USER_HOST,
    InvalidTenantName,
    database_and_user_name,
    sql_identifier,
    validate_tenant_name,
)

DEFAULT_MAX_USER_CONNECTIONS = 10

# The socket bind-mounted out of the mysql container by db/stack/compose.yml
# (`./run/mysqld:/var/run/mysqld`), reachable from the bare host at this path
# once the stack is copied to /opt/branchleft/db per db/RUNBOOK-db.md.
DEFAULT_SOCKET = "/opt/branchleft/db/run/mysqld/mysqld.sock"


class ProvisionError(Exception):
    """Raised for anything a caller could have avoided by passing valid input,
    or that the server refused."""


def _run_sql(
    sql: str,
    *,
    socket_path: str,
    admin_user: str,
    admin_password: str,
    run=subprocess.run,
) -> str:
    result = run(
        ["mysql", "--socket", socket_path, "--user", admin_user, "-N", "-B", "-e", sql],
        env={**os.environ, "MYSQL_PWD": admin_password},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ProvisionError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def grant_database_pattern(db_name: str) -> str:
    """Escape a database name for use as a database-level GRANT target.

    MySQL reads an unescaped _ as any single character and an unescaped %
    as any run of characters in that position, so a grant on ghost_a_b
    would also cover ghost_a1b. A backslash makes the next character
    literal. The backslash itself is escaped first so the other escapes
    are not doubled.
    """
    return db_name.replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%")


def user_exists(
    db_user: str,
    *,
    socket_path: str,
    admin_user: str,
    admin_password: str,
    run=subprocess.run,
) -> bool:
    # db_user is validated upstream (validate_tenant_name + the fixed
    # TENANT_DB_PREFIX), so it can only ever be [a-z0-9_]+ -- safe to
    # interpolate into a literal without a placeholder-capable transport.
    out = _run_sql(
        f"SELECT COUNT(*) FROM mysql.user WHERE User='{db_user}' AND Host='{TENANT_USER_HOST}';",
        socket_path=socket_path,
        admin_user=admin_user,
        admin_password=admin_password,
        run=run,
    )
    return out.strip() != "0"


class ProvisionResult:
    def __init__(self, *, database: str, db_user: str, host_pattern: str, created: bool, password: str | None):
        self.database = database
        self.db_user = db_user
        self.host_pattern = host_pattern
        self.created = created
        # Only set when this call minted the account. `None` on an existing
        # tenant -- the caller never learns a password it did not just set.
        self.password = password


def provision_tenant_database(
    tenant_name: str,
    *,
    socket_path: str = DEFAULT_SOCKET,
    admin_user: str,
    admin_password: str,
    max_user_connections: int = DEFAULT_MAX_USER_CONNECTIONS,
    password_factory=lambda: secrets.token_urlsafe(32),
    run=subprocess.run,
) -> ProvisionResult:
    validate_tenant_name(tenant_name)
    db_user = database_and_user_name(sql_identifier(tenant_name))

    already_exists = user_exists(
        db_user, socket_path=socket_path, admin_user=admin_user, admin_password=admin_password, run=run
    )
    password = None if already_exists else password_factory()

    statements = [
        f"CREATE DATABASE IF NOT EXISTS `{db_user}` "
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    ]
    if not already_exists:
        # Password is a generated value, never one that could carry a quote
        # this f-string would need to escape.
        statements.append(
            f"CREATE USER '{db_user}'@'{TENANT_USER_HOST}' IDENTIFIED BY '{password}';"
        )
    statements.append(
        f"GRANT ALL PRIVILEGES ON `{grant_database_pattern(db_user)}`.* "
        f"TO '{db_user}'@'{TENANT_USER_HOST}';"
    )
    statements.append(
        f"ALTER USER '{db_user}'@'{TENANT_USER_HOST}' "
        f"WITH MAX_USER_CONNECTIONS {int(max_user_connections)};"
    )
    statements.append("FLUSH PRIVILEGES;")

    _run_sql(
        "\n".join(statements),
        socket_path=socket_path,
        admin_user=admin_user,
        admin_password=admin_password,
        run=run,
    )

    return ProvisionResult(
        database=db_user,
        db_user=db_user,
        host_pattern=TENANT_USER_HOST,
        created=not already_exists,
        password=password,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tenant_name")
    parser.add_argument("--socket", dest="socket_path", default=DEFAULT_SOCKET)
    parser.add_argument("--admin-user", default="root")
    parser.add_argument(
        "--max-user-connections", type=int, default=DEFAULT_MAX_USER_CONNECTIONS
    )
    args = parser.parse_args(argv)

    admin_password = os.environ.get("MYSQL_PWD")
    if not admin_password:
        print("MYSQL_PWD must be set in the environment (never as an argument).", file=sys.stderr)
        return 2

    try:
        result = provision_tenant_database(
            args.tenant_name,
            socket_path=args.socket_path,
            admin_user=args.admin_user,
            admin_password=admin_password,
            max_user_connections=args.max_user_connections,
        )
    except InvalidTenantName as exc:
        print(f"provision_tenant_db: {exc}", file=sys.stderr)
        return 1
    except ProvisionError as exc:
        print(f"provision_tenant_db: {exc}", file=sys.stderr)
        return 1

    if result.created:
        print(f"database={result.database} user={result.db_user}@{result.host_pattern}")
        print(f"password={result.password}")
        print(
            "Store the password now -- this is the only time it is printed.",
            file=sys.stderr,
        )
    else:
        print(
            f"{result.db_user}@{result.host_pattern} already existed; "
            "escaped grant added beside any existing grant (an old unescaped row is "
            "left in place); "
            f"MAX_USER_CONNECTIONS={args.max_user_connections} reapplied, "
            "password unchanged."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

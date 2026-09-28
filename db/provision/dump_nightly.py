#!/usr/bin/env python3
"""Nightly logical dump of every database on db1, encrypted client-side and
shipped to Object Storage.

`--source-data=2` (a commented resume point, since `--all-databases`
rejects the uncommented `=1`) and `@@server_uuid`-namespaced object keys are
both load-bearing for restore -- see dump_nightly.md for why.
"""

from __future__ import annotations

import datetime
import os
import subprocess
import sys
import tempfile

from objectstorage import ObjectStorageError, put_object

DUMP_MYSQL_USER = "backup"

# The socket bind-mounted out of the mysql container by db/stack/compose.yml,
# reachable from the bare host at this path once the stack is copied to
# /opt/branchleft/db per db/RUNBOOK-db.md.
DEFAULT_SOCKET = "/opt/branchleft/db/run/mysqld/mysqld.sock"


class DumpError(Exception):
    """A stage of the pipeline did not complete."""


def _run_mysql(sql: str, *, socket_path: str, user: str, password: str, run) -> str:
    result = run(
        ["mysql", "--socket", socket_path, "--user", user, "-N", "-B", "-e", sql],
        env={**os.environ, "MYSQL_PWD": password},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise DumpError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def get_server_uuid(*, socket_path: str, password: str, run=subprocess.run) -> str:
    out = _run_mysql(
        "SELECT @@server_uuid;", socket_path=socket_path, user=DUMP_MYSQL_USER, password=password, run=run
    )
    server_uuid = out.strip()
    if not server_uuid:
        raise DumpError("SELECT @@server_uuid; returned nothing")
    return server_uuid


def run_mysqldump(*, socket_path: str, password: str, out_path: str, run=subprocess.run) -> None:
    with open(out_path, "wb") as handle:
        result = run(
            [
                "mysqldump",
                "--socket",
                socket_path,
                "--user",
                DUMP_MYSQL_USER,
                "--all-databases",
                "--single-transaction",
                "--source-data=2",
                "--routines",
                "--triggers",
                "--set-gtid-purged=OFF",
            ],
            env={**os.environ, "MYSQL_PWD": password},
            stdout=handle,
            stderr=subprocess.PIPE,
            check=False,
        )
    if result.returncode != 0:
        raise DumpError(f"mysqldump exited {result.returncode}: {result.stderr.decode(errors='replace')}")


def encrypt_with_age(*, in_path: str, out_path: str, recipient: str, run=subprocess.run) -> None:
    result = run(
        ["age", "-r", recipient, "-o", out_path, in_path],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise DumpError(f"age exited {result.returncode}: {result.stderr.decode(errors='replace')}")


def object_key_for(server_uuid: str, now: datetime.datetime) -> str:
    return f"dumps/{server_uuid}/db1-{now.strftime('%Y%m%dT%H%M%SZ')}.sql.age"


def run_dump(
    *,
    socket_path: str,
    password: str,
    recipient: str,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    now: datetime.datetime | None = None,
    run=subprocess.run,
    upload=put_object,
) -> str:
    """Returns the object key written on success; raises DumpError or
    ObjectStorageError otherwise."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    server_uuid = get_server_uuid(socket_path=socket_path, password=password, run=run)

    with tempfile.TemporaryDirectory(prefix="branchleft-db-dump-") as tmp:
        plain_path = os.path.join(tmp, "dump.sql")
        encrypted_path = os.path.join(tmp, "dump.sql.age")

        run_mysqldump(socket_path=socket_path, password=password, out_path=plain_path, run=run)
        encrypt_with_age(in_path=plain_path, out_path=encrypted_path, recipient=recipient, run=run)

        with open(encrypted_path, "rb") as handle:
            ciphertext = handle.read()

        key = object_key_for(server_uuid, now)
        upload(
            bucket=bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            key=key,
            data=ciphertext,
        )
        return key


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise DumpError(f"{name} must be set (see /etc/branchleft/db.env)")
    return value


def main(argv: list[str]) -> int:
    socket_path = argv[0] if argv else DEFAULT_SOCKET
    try:
        key = run_dump(
            socket_path=socket_path,
            password=_require_env("DB_DUMP_MYSQL_PWD"),
            recipient=_require_env("AGE_RECIPIENT_PUBLIC_KEY"),
            bucket=_require_env("DB_BACKUP_BUCKET"),
            endpoint=_require_env("DB_BACKUP_ENDPOINT"),
            region=_require_env("DB_BACKUP_REGION"),
            access_key=_require_env("AWS_ACCESS_KEY_ID"),
            secret_key=_require_env("AWS_SECRET_ACCESS_KEY"),
        )
    except (DumpError, ObjectStorageError) as exc:
        print(f"dump_nightly: {exc}", file=sys.stderr)
        return 1
    print(f"dump_nightly: wrote {key}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

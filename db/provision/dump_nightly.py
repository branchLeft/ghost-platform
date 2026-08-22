#!/usr/bin/env python3
"""Nightly logical dump of every database on db1, encrypted client-side and
shipped to Object Storage.

Run by branchleft-db-dump.timer via branchleft-db-dump.service, as root on
db1. Reads DB_DUMP_MYSQL_PWD, AGE_RECIPIENT_PUBLIC_KEY, DB_BACKUP_BUCKET,
DB_BACKUP_ENDPOINT, DB_BACKUP_REGION, AWS_ACCESS_KEY_ID and
AWS_SECRET_ACCESS_KEY from the environment -- /etc/branchleft/db.env via the
unit's EnvironmentFile.

Connects over the Unix socket bind-mounted out of the mysql container
(`./run/mysqld:/var/run/mysqld` in db/stack/compose.yml) as the dedicated
`backup`@`localhost` account -- never TCP, so this never depends on
`bind-address` covering a loopback or private address for this account.

The dump lands in a directory `tempfile` deletes on the way out, on every
exit path including a failure partway through: nothing this script writes to
disk is ever the encryption key or an unencrypted dump that outlives the run.
Object Storage is the only place a dump persists -- there is no "last dump"
kept locally to fall back on, so a failed run is retried whole by the next
scheduled one rather than resumed.

`--source-data=2` embeds the binlog file and position current at the start
of the dump as a *comment* -- the uncommented form (`=1`) is rejected by
`--all-databases` outright, and a comment is exactly what the PITR restore
drill needs to find where to resume binlog replay from.

Object keys are namespaced under MySQL's own `@@server_uuid`, which the
server mints fresh whenever its data directory is created from scratch --
exactly the host-loss/rebuild case where binlog and dump numbering would
otherwise restart from the same names an earlier incarnation already used.
Without the namespace, a rebuild's first dump would silently overwrite the
pre-rebuild archive under an identical key.
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

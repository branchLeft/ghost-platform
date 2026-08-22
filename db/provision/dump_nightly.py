#!/usr/bin/env python3
"""Nightly logical dump of every database on db1, encrypted client-side and
shipped to Object Storage.

Run by branchleft-db-dump.timer via branchleft-db-dump.service, as root on
db1. Reads DB_DUMP_MYSQL_PWD, AGE_RECIPIENT_PUBLIC_KEY, DB_BACKUP_BUCKET,
DB_BACKUP_ENDPOINT, DB_BACKUP_REGION, AWS_ACCESS_KEY_ID and
AWS_SECRET_ACCESS_KEY from the environment -- /etc/branchleft/db.env via the
unit's EnvironmentFile.

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
"""

from __future__ import annotations

import datetime
import os
import subprocess
import sys
import tempfile

from objectstorage import ObjectStorageError, put_object

DUMP_MYSQL_USER = "backup"


class DumpError(Exception):
    """A stage of the pipeline did not complete."""


def run_mysqldump(*, host: str, password: str, out_path: str, run=subprocess.run) -> None:
    with open(out_path, "wb") as handle:
        result = run(
            [
                "mysqldump",
                "--host",
                host,
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


def object_key_for(now: datetime.datetime) -> str:
    return f"dumps/db1-{now.strftime('%Y%m%dT%H%M%SZ')}.sql.age"


def run_dump(
    *,
    host: str,
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
    with tempfile.TemporaryDirectory(prefix="branchleft-db-dump-") as tmp:
        plain_path = os.path.join(tmp, "dump.sql")
        encrypted_path = os.path.join(tmp, "dump.sql.age")

        run_mysqldump(host=host, password=password, out_path=plain_path, run=run)
        encrypt_with_age(in_path=plain_path, out_path=encrypted_path, recipient=recipient, run=run)

        with open(encrypted_path, "rb") as handle:
            ciphertext = handle.read()

        key = object_key_for(now)
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
    host = argv[0] if argv else "127.0.0.1"
    try:
        key = run_dump(
            host=host,
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

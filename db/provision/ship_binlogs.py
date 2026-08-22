#!/usr/bin/env python3
"""Ship every closed binary log db1 is holding to Object Storage.

Run frequently (every 15 minutes, via branchleft-db-binlog-ship.timer) so
the RPO on host loss stays close to that interval rather than the 24h a
dump-only design would leave stated in doc 14 -- see the amendment on the
tracking issue this pipeline exists to close. `FLUSH BINARY LOGS` rotates to
a fresh file on every run, so the log that was open a moment ago becomes
closed and shippable on the very next run; nothing here ever reads from the
file MySQL is currently writing.

A local marker file (`--marker-path`, default under
/var/lib/branchleft-db-binlog-ship/) records the name of the last binlog
shipped, so a run resumes exactly where the previous one stopped rather than
re-shipping or skipping. `mysqlbinlog --raw --read-from-remote-server` reads
the byte-identical file over the replication protocol, which is what makes
this possible with no filesystem access to the `mysql-data` volume at all --
this script never runs inside the MySQL container and never needs to.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

from objectstorage import ObjectStorageError, put_object

BINLOG_MYSQL_USER = "replicator"

DEFAULT_MARKER_PATH = "/var/lib/branchleft-db-binlog-ship/last-shipped"


class ShipError(Exception):
    """A stage of the pipeline did not complete for one binlog file."""


def flush_binary_logs(*, host: str, password: str, run=subprocess.run) -> None:
    _run_mysql("FLUSH BINARY LOGS;", host=host, password=password, run=run)


def list_binary_logs(*, host: str, password: str, run=subprocess.run) -> list[str]:
    """Returns every binlog file db1 currently retains, oldest first -- the
    order `SHOW BINARY LOGS` documents. The last entry is always the file
    currently being written and is excluded by every caller here."""
    out = _run_mysql("SHOW BINARY LOGS;", host=host, password=password, run=run)
    lines = [line for line in out.splitlines() if line.strip()]
    return [line.split("\t")[0] for line in lines]


def _run_mysql(sql: str, *, host: str, password: str, run) -> str:
    result = run(
        ["mysql", "--host", host, "--user", BINLOG_MYSQL_USER, "-N", "-B", "-e", sql],
        env={**os.environ, "MYSQL_PWD": password},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ShipError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def fetch_raw_binlog(
    *, host: str, password: str, log_name: str, out_dir: str, run=subprocess.run
) -> str:
    """Downloads `log_name` byte-for-byte into `out_dir`. `mysqlbinlog --raw`
    treats --result-file as a directory prefix, not an exact filename."""
    result = run(
        [
            "mysqlbinlog",
            "--read-from-remote-server",
            "--raw",
            "--host",
            host,
            "--user",
            BINLOG_MYSQL_USER,
            f"--result-file={out_dir}/",
            log_name,
        ],
        env={**os.environ, "MYSQL_PWD": password},
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ShipError(
            f"mysqlbinlog exited {result.returncode} for {log_name}: "
            f"{result.stderr.decode(errors='replace')}"
        )
    return os.path.join(out_dir, log_name)


def encrypt_with_age(*, in_path: str, out_path: str, recipient: str, run=subprocess.run) -> None:
    result = run(["age", "-r", recipient, "-o", out_path, in_path], capture_output=True, check=False)
    if result.returncode != 0:
        raise ShipError(f"age exited {result.returncode}: {result.stderr.decode(errors='replace')}")


def object_key_for(log_name: str) -> str:
    return f"binlogs/db1-{log_name}.age"


def load_marker(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip() or None
    except FileNotFoundError:
        return None


def save_marker(path: str, log_name: str) -> None:
    """Atomic replace, mirroring branchleft_deploy.py's write_image_env: a
    marker file is read by the very next timer run and must never be
    observed half-written."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    handle_fd, temporary = tempfile.mkstemp(dir=directory, prefix=".ship-binlogs-")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            handle.write(log_name)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def logs_to_ship(closed_logs: list[str], marker: str | None) -> list[str]:
    if marker is None or marker not in closed_logs:
        # No marker, or the marker names a log that has already aged out of
        # the 7-day retention window this stack keeps on-host -- ship
        # everything still retained rather than erroring or skipping it.
        return closed_logs
    return closed_logs[closed_logs.index(marker) + 1 :]


def ship_one(
    log_name: str,
    *,
    host: str,
    password: str,
    recipient: str,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    run=subprocess.run,
    upload=put_object,
) -> None:
    with tempfile.TemporaryDirectory(prefix="branchleft-db-binlog-") as tmp:
        raw_path = fetch_raw_binlog(host=host, password=password, log_name=log_name, out_dir=tmp, run=run)
        encrypted_path = os.path.join(tmp, f"{log_name}.age")
        encrypt_with_age(in_path=raw_path, out_path=encrypted_path, recipient=recipient, run=run)
        with open(encrypted_path, "rb") as handle:
            ciphertext = handle.read()
        upload(
            bucket=bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            key=object_key_for(log_name),
            data=ciphertext,
        )


def run_ship(
    *,
    host: str,
    password: str,
    recipient: str,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    marker_path: str = DEFAULT_MARKER_PATH,
    run=subprocess.run,
    upload=put_object,
) -> list[str]:
    """Returns the list of binlog names shipped this run. Stops at the first
    failure, leaving the marker at the last success -- the next run resumes
    from there rather than skipping the failed log or re-shipping what
    already succeeded."""
    flush_binary_logs(host=host, password=password, run=run)
    all_logs = list_binary_logs(host=host, password=password, run=run)
    closed_logs = all_logs[:-1]  # the last entry is always the file now open

    marker = load_marker(marker_path)
    pending = logs_to_ship(closed_logs, marker)

    shipped: list[str] = []
    for log_name in pending:
        ship_one(
            log_name,
            host=host,
            password=password,
            recipient=recipient,
            bucket=bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            run=run,
            upload=upload,
        )
        save_marker(marker_path, log_name)
        shipped.append(log_name)
    return shipped


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ShipError(f"{name} must be set (see /etc/branchleft/db.env)")
    return value


def main(argv: list[str]) -> int:
    host = argv[0] if argv else "127.0.0.1"
    try:
        shipped = run_ship(
            host=host,
            password=_require_env("DB_BINLOG_MYSQL_PWD"),
            recipient=_require_env("AGE_RECIPIENT_PUBLIC_KEY"),
            bucket=_require_env("DB_BACKUP_BUCKET"),
            endpoint=_require_env("DB_BACKUP_ENDPOINT"),
            region=_require_env("DB_BACKUP_REGION"),
            access_key=_require_env("AWS_ACCESS_KEY_ID"),
            secret_key=_require_env("AWS_SECRET_ACCESS_KEY"),
        )
    except (ShipError, ObjectStorageError) as exc:
        print(f"ship_binlogs: {exc}", file=sys.stderr)
        return 1
    print(f"ship_binlogs: shipped {len(shipped)} log(s): {', '.join(shipped) or '(none pending)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

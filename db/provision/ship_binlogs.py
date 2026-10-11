#!/usr/bin/env python3
"""Ship every closed binary log db1 is holding to Object Storage.

See ship_binlogs.md#module-overview.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import time

from objectstorage import ObjectStorageError, put_object

BINLOG_MYSQL_USER = "replicator"

DEFAULT_MARKER_PATH = "/var/lib/branchleft-db-binlog-ship/last-shipped"

# The textfile-collector directory db1's node_exporter reads, the same one
# dump_nightly.py publishes to. Names are db-specific and unlabelled: this
# file is written on db1 only.
STATUS_FILENAME = "ship_binlogs_status.prom"
DEFAULT_METRICS_DIR = "/var/lib/branchleft/backup-worker-exporter"
_LAST_SUCCESS_LINE = re.compile(
    r"\Adb_binlog_ship_last_success_timestamp_seconds\s+([0-9]+(?:\.[0-9]+)?)\s*\Z"
)

# The socket bind-mounted out of the mysql container by db/stack/compose.yml,
# reachable from the bare host at this path once the stack is copied to
# /opt/branchleft/db per db/RUNBOOK-db.md.
DEFAULT_SOCKET = "/opt/branchleft/db/run/mysqld/mysqld.sock"


class ShipError(Exception):
    """A stage of the pipeline did not complete for one binlog file."""


def _run_mysql(sql: str, *, socket_path: str, password: str, run) -> str:
    result = run(
        ["mysql", "--socket", socket_path, "--user", BINLOG_MYSQL_USER, "-N", "-B", "-e", sql],
        env={**os.environ, "MYSQL_PWD": password},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ShipError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def get_server_uuid(*, socket_path: str, password: str, run=subprocess.run) -> str:
    out = _run_mysql("SELECT @@server_uuid;", socket_path=socket_path, password=password, run=run)
    server_uuid = out.strip()
    if not server_uuid:
        raise ShipError("SELECT @@server_uuid; returned nothing")
    return server_uuid


def flush_binary_logs(*, socket_path: str, password: str, run=subprocess.run) -> None:
    _run_mysql("FLUSH BINARY LOGS;", socket_path=socket_path, password=password, run=run)


def list_binary_logs(*, socket_path: str, password: str, run=subprocess.run) -> list[str]:
    """Returns every binlog file db1 currently retains, oldest first -- the
    order `SHOW BINARY LOGS` documents. The last entry is always the file
    currently being written and is excluded by every caller here."""
    out = _run_mysql("SHOW BINARY LOGS;", socket_path=socket_path, password=password, run=run)
    lines = [line for line in out.splitlines() if line.strip()]
    return [line.split("\t")[0] for line in lines]


def fetch_raw_binlog(
    *, socket_path: str, password: str, log_name: str, out_dir: str, run=subprocess.run
) -> str:
    """Downloads `log_name` byte-for-byte into `out_dir`. `mysqlbinlog --raw`
    treats --result-file as a directory prefix, not an exact filename."""
    result = run(
        [
            "mysqlbinlog",
            "--read-from-remote-server",
            "--raw",
            "--socket",
            socket_path,
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


def object_key_for(server_uuid: str, log_name: str) -> str:
    return f"binlogs/{server_uuid}/db1-{log_name}.age"


class Marker:
    def __init__(self, server_uuid: str, log_name: str):
        self.server_uuid = server_uuid
        self.log_name = log_name


def load_marker(path: str) -> Marker | None:
    try:
        with open(path, encoding="utf-8") as handle:
            content = handle.read().strip()
    except FileNotFoundError:
        return None
    if not content:
        return None
    parts = content.split(" ", 1)
    if len(parts) != 2:
        # An older-format or corrupt marker. Treated as absent rather than
        # raised: the safe direction on a marker this script cannot trust is
        # to re-ship everything the server currently retains, never to skip.
        return None
    server_uuid, log_name = parts
    return Marker(server_uuid, log_name)


def save_marker(path: str, server_uuid: str, log_name: str) -> None:
    """Atomic replace, mirroring branchleft_deploy.py's write_image_env: a
    marker file is read by the very next timer run and must never be
    observed half-written."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    handle_fd, temporary = tempfile.mkstemp(dir=directory, prefix=".ship-binlogs-")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            handle.write(f"{server_uuid} {log_name}")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def logs_to_ship(closed_logs: list[str], marker: Marker | None, current_server_uuid: str) -> list[str]:
    if (
        marker is None
        or marker.server_uuid != current_server_uuid
        or marker.log_name not in closed_logs
    ):
        # No marker; a marker from a different (previous) server incarnation,
        # which must never be trusted to mean anything about this one's log
        # names; or a marker whose log has aged out of the 7-day on-host
        # retention window. Every case ships everything still retained
        # rather than guessing at a resume point.
        return closed_logs
    return closed_logs[closed_logs.index(marker.log_name) + 1 :]


def ship_one(
    log_name: str,
    *,
    server_uuid: str,
    socket_path: str,
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
        raw_path = fetch_raw_binlog(
            socket_path=socket_path, password=password, log_name=log_name, out_dir=tmp, run=run
        )
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
            key=object_key_for(server_uuid, log_name),
            data=ciphertext,
        )


def run_ship(
    *,
    socket_path: str,
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
    server_uuid = get_server_uuid(socket_path=socket_path, password=password, run=run)
    flush_binary_logs(socket_path=socket_path, password=password, run=run)
    all_logs = list_binary_logs(socket_path=socket_path, password=password, run=run)
    closed_logs = all_logs[:-1]  # the last entry is always the file now open

    marker = load_marker(marker_path)
    pending = logs_to_ship(closed_logs, marker, server_uuid)

    shipped: list[str] = []
    for log_name in pending:
        ship_one(
            log_name,
            server_uuid=server_uuid,
            socket_path=socket_path,
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
        save_marker(marker_path, server_uuid, log_name)
        shipped.append(log_name)
    return shipped


def _previous_success(path: str) -> float | None:
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                match = _LAST_SUCCESS_LINE.match(line.strip())
                if match:
                    return float(match.group(1))
    except (OSError, ValueError):
        pass
    return None


def record_run_status(*, metrics_dir: str | None, succeeded: bool, now: float | None = None) -> None:
    """Publishes whether this run succeeded and when one last did. A failed
    run carries the previous success time forward unchanged. Best-effort and
    atomic: any failure here is printed and swallowed, never the shipper's."""
    if not metrics_dir:
        return
    try:
        path = os.path.join(metrics_dir, STATUS_FILENAME)
        stamp = time.time() if now is None else now
        last_success = stamp if succeeded else _previous_success(path)
        lines = [
            "# HELP db_binlog_ship_last_run_success 1 if the latest binlog shipping run succeeded, else 0.",
            "# TYPE db_binlog_ship_last_run_success gauge",
            f"db_binlog_ship_last_run_success {1 if succeeded else 0}",
        ]
        if last_success is not None:
            lines += [
                "# HELP db_binlog_ship_last_success_timestamp_seconds Unix time the last run that shipped every closed binlog finished.",
                "# TYPE db_binlog_ship_last_success_timestamp_seconds gauge",
                f"db_binlog_ship_last_success_timestamp_seconds {last_success:.0f}",
            ]
        os.makedirs(metrics_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=metrics_dir, prefix=STATUS_FILENAME + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as handle:
                handle.write("\n".join(lines) + "\n")
            os.chmod(tmp, 0o644)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    except Exception as exc:  # a metrics fault must never become the shipper's fault
        print(f"ship_binlogs: could not write run status to {metrics_dir!r}: {exc}", file=sys.stderr)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ShipError(f"{name} must be set (see /etc/branchleft/db.env)")
    return value


def main(argv: list[str]) -> int:
    socket_path = argv[0] if argv else DEFAULT_SOCKET
    metrics_dir = os.environ.get("DB_BINLOG_METRICS_DIR", DEFAULT_METRICS_DIR)
    try:
        shipped = run_ship(
            socket_path=socket_path,
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
        record_run_status(metrics_dir=metrics_dir, succeeded=False)
        return 1
    except BaseException:
        record_run_status(metrics_dir=metrics_dir, succeeded=False)
        raise
    print(f"ship_binlogs: shipped {len(shipped)} log(s): {', '.join(shipped) or '(none pending)'}")
    record_run_status(metrics_dir=metrics_dir, succeeded=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

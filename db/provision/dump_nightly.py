#!/usr/bin/env python3
"""Nightly logical dump of every database on db1, encrypted client-side and
shipped to Object Storage.

The dump is taken one user schema at a time, each under its own
`bounded_snapshot`: table locks on that schema alone, with a bounded wait and
hold, never `FLUSH TABLES`. Each schema's section carries its own resume
point, and the `@@server_uuid`-namespaced object keys, both load-bearing for
restore. See dump_nightly.md.
"""

from __future__ import annotations

import contextlib
import dataclasses
import datetime
import functools
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

import bounded_snapshot
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


# Every dump names its databases with `--databases` after these, one
# section per user schema; see run_mysqldump.
DUMP_ARGS = (
    "--single-transaction",
    "--routines",
    "--triggers",
    "--set-gtid-purged=OFF",
)

# Dumped with the first section, never locked: the same treatment they had
# under `--all-databases`. A schema with no base table has nothing to lock
# and rides with them.
UNLOCKED_SCHEMAS = ("mysql", "sys")

# One resume point per section, in a form no earlier reader matches: a reader
# that only knows the bare `-- CHANGE MASTER TO` comment finds none and
# refuses, instead of replaying every schema from one schema's position.
# extract_tenant_binlog.SECTION_RESUME_PATTERN reads it back.
SECTION_PREFIX = "-- BRANCHLEFT-SECTION "


# The same metric names the control host's worker publishes, under this
# label, so one set of alert rules covers both. See dump_nightly.md#metrics.
METRICS_LABEL = "db1-all-databases"
METRICS_FILENAME = "dump_nightly_lock_bound.prom"
DEFAULT_METRICS_DIR = "/var/lib/branchleft/backup-worker-exporter"
_ABORTS_LINE = re.compile(
    r'\Abackup_worker_lock_aborts_total\{tenant="' + re.escape(METRICS_LABEL) + r'"\}\s+([0-9]+(?:\.[0-9]+)?)\s*\Z'
)


@dataclasses.dataclass(frozen=True)
class NightlyReport:
    """The run's snapshots, one per dumped section. The gauges name the worst
    single section, since that is what one tenant's writers could wait for;
    the abort counter adds every section up."""

    sections: tuple[bounded_snapshot.SnapshotReport, ...]
    skipped_schemas: tuple[str, ...] = ()

    @property
    def lock_wait_seconds(self) -> float:
        return max((section.lock_wait_seconds for section in self.sections), default=0.0)

    @property
    def hold_seconds(self) -> float:
        return max((section.hold_seconds for section in self.sections), default=0.0)

    @property
    def tables_locked(self) -> int:
        return sum(section.tables_locked for section in self.sections)

    @property
    def attempts(self) -> int:
        return sum(section.attempts for section in self.sections)

    @property
    def aborted_attempts(self) -> int:
        return sum(section.aborted_attempts for section in self.sections)


def record_lock_metrics(*, metrics_dir: str, report: NightlyReport | None, aborts: int) -> None:
    """Writes the wait and hold gauges (when a snapshot was taken) and adds
    `aborts` to the cumulative counter. Best-effort: never fails the dump."""
    path = pathlib.Path(metrics_dir) / METRICS_FILENAME
    try:
        previous = 0.0
        try:
            for line in path.read_text().splitlines():
                match = _ABORTS_LINE.match(line.strip())
                if match:
                    previous = float(match.group(1))
        except FileNotFoundError:
            pass
        label = f'{{tenant="{METRICS_LABEL}"}}'
        lines = []
        if report is not None:
            lines += [
                "# TYPE backup_worker_lock_wait_seconds gauge",
                f"backup_worker_lock_wait_seconds{label} {report.lock_wait_seconds}",
                "# TYPE backup_worker_lock_hold_seconds gauge",
                f"backup_worker_lock_hold_seconds{label} {report.hold_seconds}",
            ]
        lines += [
            "# TYPE backup_worker_lock_aborts_total counter",
            f"backup_worker_lock_aborts_total{label} {previous + max(int(aborts), 0):g}",
        ]
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
        with os.fdopen(fd, "w") as handle:
            handle.write("\n".join(lines) + "\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError as exc:
        print(f"dump_nightly: could not write lock metrics to {metrics_dir!r}: {exc}", file=sys.stderr)


# The run's own outcome, in its own file so the lock gauges above keep their
# writer untouched. Names are db-specific on purpose: a name shared with the
# control host's worker would let that host's series hide this one's absence.
STATUS_FILENAME = "dump_nightly_status.prom"
_LAST_SUCCESS_LINE = re.compile(
    r"\Adb_nightly_dump_last_success_timestamp_seconds\s+([0-9]+(?:\.[0-9]+)?)\s*\Z"
)


def _previous_success(path: pathlib.Path) -> float | None:
    try:
        for line in path.read_text().splitlines():
            match = _LAST_SUCCESS_LINE.match(line.strip())
            if match:
                return float(match.group(1))
    except (OSError, ValueError):
        pass
    return None


def record_run_status(*, metrics_dir: str | None, succeeded: bool, now: float | None = None) -> None:
    """Publishes whether this run succeeded and when one last did. A failed
    run carries the previous success time forward unchanged. Best-effort and
    atomic: any failure here is printed and swallowed, never the dump's."""
    if not metrics_dir:
        return
    try:
        path = pathlib.Path(metrics_dir) / STATUS_FILENAME
        stamp = time.time() if now is None else now
        last_success = stamp if succeeded else _previous_success(path)
        lines = [
            "# HELP db_nightly_dump_last_run_success 1 if the latest nightly dump run succeeded, else 0.",
            "# TYPE db_nightly_dump_last_run_success gauge",
            f"db_nightly_dump_last_run_success {1 if succeeded else 0}",
        ]
        if last_success is not None:
            lines += [
                "# HELP db_nightly_dump_last_success_timestamp_seconds Unix time the last successful dump finished uploading.",
                "# TYPE db_nightly_dump_last_success_timestamp_seconds gauge",
                f"db_nightly_dump_last_success_timestamp_seconds {last_success:.0f}",
            ]
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as handle:
                handle.write("\n".join(lines) + "\n")
            os.chmod(tmp, 0o644)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    except Exception as exc:  # a metrics fault must never become the dump's fault
        print(f"dump_nightly: could not write run status to {metrics_dir!r}: {exc}", file=sys.stderr)


def section_comment(report: bounded_snapshot.SnapshotReport) -> bytes:
    """The resume point of one section, in the form extract_tenant_binlog reads."""
    return f"{SECTION_PREFIX}CHANGE MASTER TO MASTER_LOG_FILE='{report.log_file}', MASTER_LOG_POS={report.log_position};\n".encode()


def _list_names(sql: str, *, factory: bounded_snapshot.ClientFactory, limits: bounded_snapshot.Limits) -> list[str]:
    """First column of every row `sql` returns, from a one-off mysql session."""
    process = factory.spawn(
        "mysql",
        ["--batch", "--skip-column-names", "--connect-timeout=5", "-e", sql],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=limits.setup_timeout_seconds)
    except subprocess.TimeoutExpired:
        bounded_snapshot.kill_process(process)
        process.communicate()
        raise DumpError(f"listing schemas did not finish within {limits.setup_timeout_seconds}s") from None
    if process.returncode != 0:
        raise DumpError(f"listing schemas: mysql exited {process.returncode}: {err.decode(errors='replace').strip()}")
    return [line.partition("\t")[0] for line in out.decode(errors="replace").splitlines() if line]


def list_user_schemas(
    *, factory: bounded_snapshot.ClientFactory, limits: bounded_snapshot.Limits
) -> tuple[list[str], list[str]]:
    """(schemas with at least one base table, the other user schemas), each
    sorted. Only the first kind has anything to lock."""
    system = ", ".join("'" + name + "'" for name in bounded_snapshot.SYSTEM_SCHEMAS)
    everything = _list_names(
        f"SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ({system}) ORDER BY SCHEMA_NAME;",
        factory=factory,
        limits=limits,
    )
    with_tables = set(_list_names(bounded_snapshot.list_tables_sql(None), factory=factory, limits=limits))
    for name in everything:
        if name.startswith("-"):
            raise DumpError("a schema name starting with '-' would be read by mysqldump as an option; not dumped")
    return [name for name in everything if name in with_tables], [name for name in everything if name not in with_tables]


def _log(message: str) -> None:
    print(f"dump_nightly: {message}", file=sys.stderr)


def _log_section(where: str, message: str) -> None:
    _log(f"{where}: {message}")


def _stream_section(handle, dump: bounded_snapshot.StartedDump, report: bounded_snapshot.SnapshotReport) -> int:
    """Writes one section: its resume point, then what its mysqldump prints.
    Returns that mysqldump's exit code; a failure while writing kills it."""
    try:
        handle.write(section_comment(report))
        for chunk in iter(lambda: dump.process.stdout.read(1 << 16), b""):
            handle.write(chunk)
        exit_code = dump.process.wait()
    except BaseException:
        bounded_snapshot.kill_process(dump.process)
        raise
    finally:
        dump.process.stdout.close()
    dump.stderr.join(5.0)
    if exit_code != 0:
        raise DumpError(f"mysqldump exited {exit_code}: {dump.stderr.text()}")
    return exit_code


def run_mysqldump(
    *,
    socket_path: str,
    password: str,
    out_path: str,
    popen=subprocess.Popen,
    limits: bounded_snapshot.Limits = bounded_snapshot.Limits(),
    sleep=time.sleep,
    metrics_dir: str | None = None,
) -> NightlyReport:
    """Writes the dump to `out_path` one user schema at a time: each schema's
    tables are locked by themselves for its snapshot, and its section opens
    with its own resume point. No lock ever names two schemas, so a tenant's
    writers are never held for another tenant's lock. `mysql`, `sys` and any
    schema with no base table are dumped inside the first section, unlocked.
    See dump_nightly.md#the-snapshot."""
    factory = bounded_snapshot.ClientFactory(
        connection_args=["--socket", socket_path, "--user", DUMP_MYSQL_USER],
        password=password,
        env={"PATH": os.environ.get("PATH", "")},
        popen=popen,
    )
    locked, tableless = list_user_schemas(factory=factory, limits=limits)
    if not locked:
        raise DumpError("no base tables to lock in any user schema")

    carried = [*tableless, *UNLOCKED_SCHEMAS]  # dumped with the first section that is taken
    reports: list[bounded_snapshot.SnapshotReport] = []
    skipped: list[str] = []
    aborts = 0
    with contextlib.ExitStack() as stack:
        try:
            handle = None
            for index, schema in enumerate(locked, start=1):
                where = f"section {index}/{len(locked)}"
                try:
                    dump, report = bounded_snapshot.take_bounded_snapshot(
                        factory=factory,
                        schemas=[schema],
                        dump_args=(*DUMP_ARGS, "--databases", schema, *carried),
                        limits=limits,
                        sleep=sleep,
                        log=functools.partial(_log_section, where),
                    )
                except bounded_snapshot.SnapshotError as exc:
                    aborts += exc.aborted_attempts
                    # Only a schema the server confirms is gone is left out: it
                    # has nothing left to lock. Anything else fails the run.
                    with_tables, without_tables = list_user_schemas(factory=factory, limits=limits)
                    if schema in (*with_tables, *without_tables):
                        raise DumpError(
                            f"no consistent snapshot ({exc.aborted_attempts} lock attempt(s) aborted on a bound): {exc}"
                        ) from exc
                    skipped.append(schema)
                    _log(f"{where}: schema {schema!r} no longer exists, not dumped")
                    continue
                reports.append(report)
                aborts += report.aborted_attempts
                carried = []
                if handle is None:
                    handle = stack.enter_context(open(out_path, "wb"))
                _stream_section(handle, dump, report)
                _log(
                    f"{where}: snapshot at {report.log_file}:{report.log_position}, lock wait "
                    f"{report.lock_wait_seconds:.3f}s, hold {report.hold_seconds:.3f}s, "
                    f"{report.aborted_attempts} aborted lock attempt(s), {report.tables_locked} tables locked"
                )
            if not reports:
                raise DumpError("no user schema could be dumped: every one listed had gone by the time it was locked")
        finally:
            if metrics_dir is not None:
                record_lock_metrics(
                    metrics_dir=metrics_dir,
                    report=NightlyReport(sections=tuple(reports)) if reports else None,
                    aborts=aborts,
                )
    return NightlyReport(sections=tuple(reports), skipped_schemas=tuple(skipped))


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
    popen=subprocess.Popen,
    upload=put_object,
    limits: bounded_snapshot.Limits = bounded_snapshot.Limits(),
    sleep=time.sleep,
    metrics_dir: str | None = None,
) -> str:
    """Returns the object key written on success; raises DumpError or
    ObjectStorageError otherwise."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    server_uuid = get_server_uuid(socket_path=socket_path, password=password, run=run)

    with tempfile.TemporaryDirectory(prefix="branchleft-db-dump-") as tmp:
        plain_path = os.path.join(tmp, "dump.sql")
        encrypted_path = os.path.join(tmp, "dump.sql.age")

        run_mysqldump(
            socket_path=socket_path,
            password=password,
            out_path=plain_path,
            popen=popen,
            limits=limits,
            sleep=sleep,
            metrics_dir=metrics_dir,
        )
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
    metrics_dir = os.environ.get("DB_DUMP_METRICS_DIR", DEFAULT_METRICS_DIR)
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
            metrics_dir=metrics_dir,
        )
    except (DumpError, ObjectStorageError) as exc:
        print(f"dump_nightly: {exc}", file=sys.stderr)
        record_run_status(metrics_dir=metrics_dir, succeeded=False)
        return 1
    except BaseException:
        record_run_status(metrics_dir=metrics_dir, succeeded=False)
        raise
    print(f"dump_nightly: wrote {key}")
    # After the upload and the journal line: the dump is already stored.
    record_run_status(metrics_dir=metrics_dir, succeeded=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

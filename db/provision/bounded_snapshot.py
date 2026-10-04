#!/usr/bin/env python3
"""A consistent dump whose locks can never stall writers past a fixed bound.

One coordinator session takes `LOCK TABLES ... READ` on exactly the tables
named (one tenant's, or every user schema's), with the server bounding the
wait. Under that lock it reads the binary-log position, starts mysqldump's
own `--single-transaction` snapshot, confirms the snapshot is open, and
unlocks. Nothing here ever issues `FLUSH TABLES`. Shared by the per-tenant
transport on the control host and by db1's nightly dump: one code path.
See bounded_snapshot.md.
"""

from __future__ import annotations

import collections
import dataclasses
import json
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Mapping, Sequence

# The server's own bound on every lock wait the coordinator makes, in whole
# seconds (the variable's unit). See bounded_snapshot.md#the-bounds.
LOCK_WAIT_TIMEOUT_SECONDS = 1

# The client's own bound on the same wait, for the case the server's
# per-table timeout cannot cover: several tables each waiting just under it.
WAIT_DEADLINE_SECONDS = 1.2

# How long the lock may be held, from grant to the server confirming the
# unlock. The wait and the hold together stay under two seconds.
HOLD_BOUND_SECONDS = 0.6

# The coordinator session's `wait_timeout`: if this process stops talking to
# the server mid-hold, the server drops the session and its locks by itself.
SERVER_IDLE_BACKSTOP_SECONDS = 2

MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (1.0, 2.0, 4.0, 8.0)

# Connecting and listing tables, before any lock is requested.
SETUP_TIMEOUT_SECONDS = 15.0

# Every call that kills or releases a session gives up after this long.
RELEASE_TIMEOUT_SECONDS = 5.0

# mysqldump -v prints this to stderr straight after its START TRANSACTION
# WITH CONSISTENT SNAPSHOT has returned, before it reads any table.
SNAPSHOT_OPEN_MARKER = "-- Setting savepoint"

SYSTEM_SCHEMAS = ("mysql", "sys", "performance_schema", "information_schema")

_LOCK_WAIT_TIMEOUT_ERROR = "ERROR 1205"
_UNKNOWN_THREAD_ERROR = "ERROR 1094"
_STDERR_TAIL_LINES = 40


class SnapshotError(Exception):
    """No consistent snapshot was taken. `aborted_attempts` counts the
    attempts given up on a bound, so a caller can report them even when
    every attempt failed."""

    def __init__(self, message: str, *, attempts: int, aborted_attempts: int) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.aborted_attempts = aborted_attempts


class _Abort(Exception):
    """One attempt gave up on a bound. Retried after a back-off."""


class _Fatal(Exception):
    """One attempt failed for a reason a retry cannot fix."""


@dataclasses.dataclass(frozen=True)
class Limits:
    lock_wait_timeout_seconds: int = LOCK_WAIT_TIMEOUT_SECONDS
    wait_deadline_seconds: float = WAIT_DEADLINE_SECONDS
    hold_bound_seconds: float = HOLD_BOUND_SECONDS
    server_idle_backstop_seconds: int = SERVER_IDLE_BACKSTOP_SECONDS
    max_attempts: int = MAX_ATTEMPTS
    backoff_seconds: tuple[float, ...] = BACKOFF_SECONDS
    setup_timeout_seconds: float = SETUP_TIMEOUT_SECONDS
    release_timeout_seconds: float = RELEASE_TIMEOUT_SECONDS


@dataclasses.dataclass(frozen=True)
class SnapshotReport:
    """The attempt that succeeded, measured in the coordinator session."""

    log_file: str
    log_position: int
    lock_wait_seconds: float
    hold_seconds: float
    tables_locked: int
    attempts: int
    aborted_attempts: int

    def coordinates_comment(self) -> bytes:
        """The exact commented form `extract_tenant_binlog.py` parses."""
        return (
            f"-- CHANGE MASTER TO MASTER_LOG_FILE='{self.log_file}', MASTER_LOG_POS={self.log_position};\n"
        ).encode()


class ClientFactory:
    """Starts `mysql` or `mysqldump` against one server as one account. The
    password reaches each child only through an inherited pipe fd, read once
    as an option file: never argv, never the child's environment."""

    def __init__(
        self,
        *,
        connection_args: Sequence[str],
        password: str,
        env: Mapping[str, str],
        popen=subprocess.Popen,
    ) -> None:
        self._connection_args = list(connection_args)
        self._password = password
        self._env = dict(env)
        self._popen = popen

    def spawn(self, binary: str, args: Sequence[str], **kwargs) -> subprocess.Popen:
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, f"[client]\npassword={self._password}\n".encode())
        finally:
            os.close(write_fd)
        argv = [binary, f"--defaults-extra-file=/dev/fd/{read_fd}", *self._connection_args, *args]
        try:
            return self._popen(argv, env=dict(self._env), pass_fds=(read_fd,), **kwargs)
        finally:
            os.close(read_fd)


def kill_process(process) -> None:
    """Kills a child and everything it started; never raises."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (AttributeError, TypeError, ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            pass


def _close_quietly(stream) -> None:
    try:
        stream.close()
    except (AttributeError, OSError, ValueError):
        pass


class _SessionEnded(Exception):
    def __init__(self, stderr_text: str) -> None:
        super().__init__(stderr_text)
        self.stderr_text = stderr_text


class _DeadlinePassed(Exception):
    pass


class _StderrTail:
    """Drains a child's stderr on its own thread, so the child can never
    block on a full pipe, keeping only the last lines and noting `marker`."""

    def __init__(self, stream, *, marker: str | None = None) -> None:
        self._lines: collections.deque[str] = collections.deque(maxlen=_STDERR_TAIL_LINES)
        self._marker = marker
        self.marker_seen = threading.Event()
        self.ended = threading.Event()
        self._changed = threading.Event()
        self._thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
        self._thread.start()

    def _drain(self, stream) -> None:
        try:
            for raw in stream:
                line = raw.decode(errors="replace").rstrip("\n")
                if self._marker is not None and line.startswith(self._marker):
                    self.marker_seen.set()
                    self._changed.set()
                elif not line.startswith("-- "):
                    self._lines.append(line)
        except (OSError, ValueError):
            pass
        finally:
            _close_quietly(stream)
            self.ended.set()
            self._changed.set()

    def wait_for_marker(self, timeout: float) -> bool:
        """True once the marker is seen; False at the timeout or if the
        stream ends first."""
        if timeout > 0:
            self._changed.wait(timeout)
        return self.marker_seen.is_set()

    def join(self, timeout: float) -> None:
        self._thread.join(timeout)

    def text(self) -> str:
        return "\n".join(self._lines)


class _LineReader:
    """A child's stdout as lines, read on a thread so every read can carry
    a deadline."""

    def __init__(self, stream) -> None:
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
        self._thread.start()

    def _drain(self, stream) -> None:
        try:
            for raw in stream:
                self._queue.put(raw.decode(errors="replace").rstrip("\n"))
        except (OSError, ValueError):
            pass
        finally:
            _close_quietly(stream)
            self._queue.put(None)

    def get(self, timeout: float) -> str | None:
        try:
            return self._queue.get(timeout=max(timeout, 0.0))
        except queue.Empty as exc:
            raise _DeadlinePassed() from exc


class _Coordinator:
    """One `mysql` client session, driven statement by statement over its
    stdin. A sentinel row after each request marks where its answer ends.
    Without `--force` the client exits at the first error, which closes the
    session and releases whatever it held."""

    def __init__(self, factory: ClientFactory, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._sequence = 0
        self.process = factory.spawn(
            "mysql",
            ["--batch", "--skip-column-names", "--unbuffered", "--connect-timeout=5"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self._stdout = _LineReader(self.process.stdout)
        self._stderr = _StderrTail(self.process.stderr)

    def ask(self, sql: str, deadline: float) -> list[str]:
        self._sequence += 1
        token = f"__bounded_snapshot_{self._sequence}__"
        try:
            self.process.stdin.write(f"{sql}\nSELECT '{token}';\n".encode())
            self.process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            raise _SessionEnded(self._stderr_after_exit()) from None
        lines: list[str] = []
        while True:
            line = self._stdout.get(deadline - self._clock())
            if line is None:
                raise _SessionEnded(self._stderr_after_exit())
            if line == token:
                return lines
            lines.append(line)

    def _stderr_after_exit(self) -> str:
        self._stderr.ended.wait(1.0)
        return self._stderr.text()

    def close(self, timeout: float) -> None:
        _close_quietly(self.process.stdin)
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill()

    def kill(self) -> None:
        kill_process(self.process)
        _close_quietly(self.process.stdin)
        try:
            self.process.wait(timeout=RELEASE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            pass


def _quote_identifier(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def _quote_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def list_tables_sql(schemas: Sequence[str] | None) -> str:
    """Every base table to lock: the named schemas', or every user
    schema's when `schemas` is None."""
    if schemas is None:
        scope = "TABLE_SCHEMA NOT IN (" + ", ".join(_quote_string(s) for s in SYSTEM_SCHEMAS) + ")"
    else:
        scope = "TABLE_SCHEMA IN (" + ", ".join(_quote_string(s) for s in schemas) + ")"
    return (
        "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES "
        f"WHERE TABLE_TYPE = 'BASE TABLE' AND {scope} ORDER BY TABLE_SCHEMA, TABLE_NAME;"
    )


def lock_tables_sql(tables: Sequence[tuple[str, str]]) -> str:
    return "FLUSH TABLES WITH READ LOCK;" or "LOCK TABLES " + ", ".join(
        f"{_quote_identifier(schema)}.{_quote_identifier(table)} READ" for schema, table in tables
    ) + ";"


def _parse_tables(lines: Sequence[str]) -> list[tuple[str, str]]:
    tables = []
    for line in lines:
        schema, _, table = line.partition("\t")
        tables.append((schema, table))
    return tables


def parse_log_status(lines: Sequence[str]) -> tuple[str, int]:
    """`SELECT LOCAL FROM performance_schema.log_status` gives one JSON
    document; only its binary-log file and position are used."""
    if len(lines) != 1:
        raise _Fatal(f"performance_schema.log_status returned {len(lines)} rows, expected 1")
    try:
        document = json.loads(lines[0])
        log_file = document["binary_log_file"]
        position = int(document["binary_log_position"])
    except (ValueError, KeyError, TypeError) as exc:
        raise _Fatal(f"performance_schema.log_status gave no binary-log position: {lines[0]!r}") from exc
    if not log_file:
        raise _Fatal("performance_schema.log_status names no binary log: is log_bin off?")
    return log_file, position


@dataclasses.dataclass
class StartedDump:
    """mysqldump, running inside its own consistent snapshot. The caller
    streams `process.stdout` and waits on `process`."""

    process: subprocess.Popen
    stderr: _StderrTail


def _kill_session(factory: ClientFactory, connection_id: int, limits: Limits) -> bool:
    """Ends exactly one session, by its connection id, from a second
    session as the same account. True if the session is now gone."""
    killer = factory.spawn(
        "mysql",
        ["--batch", "--skip-column-names", "--connect-timeout=5", "-e", f"KILL CONNECTION {int(connection_id)}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        _, err = killer.communicate(timeout=limits.release_timeout_seconds)
    except subprocess.TimeoutExpired:
        kill_process(killer)
        killer.communicate()
        return False
    return killer.returncode == 0 or _UNKNOWN_THREAD_ERROR in err.decode(errors="replace")


def _release(coordinator: _Coordinator, factory: ClientFactory, connection_id: int | None, limits: Limits) -> None:
    """Drops the coordinator session and confirms it is gone. Raises if
    that cannot be confirmed: the run then stops rather than retrying."""
    coordinator.kill()
    if connection_id is None:
        return
    if not _kill_session(factory, connection_id, limits):
        raise _Fatal(
            f"could not confirm the coordinator session {connection_id} was ended; the server drops "
            f"it within {limits.server_idle_backstop_seconds}s of idleness, but this run stops here"
        )


def _attempt(
    *,
    factory: ClientFactory,
    schemas: Sequence[str] | None,
    dump_args: Sequence[str],
    limits: Limits,
    clock: Callable[[], float],
) -> tuple[StartedDump, SnapshotReport]:
    coordinator = _Coordinator(factory, clock)
    connection_id: int | None = None
    dump: StartedDump | None = None
    try:
        setup_deadline = clock() + limits.setup_timeout_seconds
        connection_id = int(
            coordinator.ask(
                f"SET SESSION lock_wait_timeout = {int(limits.lock_wait_timeout_seconds)}; "
                f"SET SESSION wait_timeout = {int(limits.server_idle_backstop_seconds)}; "
                "SELECT CONNECTION_ID();",
                setup_deadline,
            )[0]
        )
        tables = _parse_tables(coordinator.ask(list_tables_sql(schemas), setup_deadline))
        if not tables:
            raise _Fatal(f"no base tables to lock in {list(schemas) if schemas is not None else 'any user schema'}")

        requested = clock()
        try:
            coordinator.ask(lock_tables_sql(tables), requested + limits.wait_deadline_seconds)
        except _DeadlinePassed:
            raise _Abort(f"lock not granted within {limits.wait_deadline_seconds}s") from None
        except _SessionEnded as exc:
            if _LOCK_WAIT_TIMEOUT_ERROR in exc.stderr_text:
                raise _Abort(f"server gave up the lock wait after {limits.lock_wait_timeout_seconds}s") from None
            raise
        granted = clock()
        hold_deadline = granted + limits.hold_bound_seconds

        try:
            if _parse_tables(coordinator.ask(list_tables_sql(schemas), hold_deadline)) != tables:
                raise _Abort("the set of tables changed while the lock was requested")
            log_file, position = parse_log_status(
                coordinator.ask("SELECT LOCAL FROM performance_schema.log_status;", hold_deadline)
            )
            process = factory.spawn(
                "mysqldump", ["-v", *dump_args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
            )
            dump = StartedDump(process=process, stderr=_StderrTail(process.stderr, marker=SNAPSHOT_OPEN_MARKER))
            if not dump.stderr.wait_for_marker(hold_deadline - clock()):
                if dump.stderr.ended.is_set():
                    raise _Abort(f"mysqldump ended before opening its snapshot: {dump.stderr.text()!r}")
                raise _Abort(f"mysqldump did not open its snapshot within the {limits.hold_bound_seconds}s hold bound")
            coordinator.ask("UNLOCK TABLES;", hold_deadline)
        except _DeadlinePassed:
            raise _Abort(f"lock held past the {limits.hold_bound_seconds}s hold bound") from None
        released = clock()
        coordinator.close(limits.release_timeout_seconds)
        report = SnapshotReport(
            log_file=log_file,
            log_position=position,
            lock_wait_seconds=granted - requested,
            hold_seconds=released - granted,
            tables_locked=len(tables),
            attempts=0,
            aborted_attempts=0,
        )
        return dump, report
    except _SessionEnded as exc:
        _cleanup(coordinator, factory, connection_id, dump, limits)
        raise _Fatal(f"coordinator session ended: {exc.stderr_text!r}") from None
    except (_Abort, _Fatal, _DeadlinePassed, ValueError, IndexError) as exc:
        _cleanup(coordinator, factory, connection_id, dump, limits)
        if isinstance(exc, (_Abort, _Fatal)):
            raise
        raise _Fatal(f"coordinator setup failed: {type(exc).__name__}: {exc}") from None


def _cleanup(coordinator, factory, connection_id, dump, limits) -> None:
    if dump is not None:
        kill_process(dump.process)
        _close_quietly(dump.process.stdout)
        try:
            dump.process.wait(timeout=limits.release_timeout_seconds)
        except subprocess.TimeoutExpired:
            pass
    _release(coordinator, factory, connection_id, limits)


def take_bounded_snapshot(
    *,
    factory: ClientFactory,
    schemas: Sequence[str] | None,
    dump_args: Sequence[str],
    limits: Limits = Limits(),
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = lambda message: None,
) -> tuple[StartedDump, SnapshotReport]:
    """Retries an attempt that gave up on a bound, after a back-off, up to
    `limits.max_attempts`; then raises `SnapshotError`. Any other failure
    raises at once. Nothing is written anywhere before success."""
    aborted = 0
    reasons: list[str] = []
    for attempt in range(1, limits.max_attempts + 1):
        try:
            dump, report = _attempt(
                factory=factory, schemas=schemas, dump_args=dump_args, limits=limits, clock=clock
            )
        except _Abort as exc:
            aborted += 1
            reasons.append(str(exc))
            log(f"bounded_snapshot: attempt {attempt}/{limits.max_attempts} aborted: {exc}")
            if attempt < limits.max_attempts:
                sleep(limits.backoff_seconds[min(attempt - 1, len(limits.backoff_seconds) - 1)])
            continue
        except _Fatal as exc:
            raise SnapshotError(str(exc), attempts=attempt, aborted_attempts=aborted) from None
        return dump, dataclasses.replace(report, attempts=attempt, aborted_attempts=aborted)
    raise SnapshotError(
        f"no snapshot after {limits.max_attempts} attempts, each given up on a lock bound: {reasons}",
        attempts=limits.max_attempts,
        aborted_attempts=aborted,
    )

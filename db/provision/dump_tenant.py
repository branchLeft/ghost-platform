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
import threading
import time

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


# How long the dump's `FLUSH TABLES WITH READ LOCK` may wait before it is
# killed. While that statement waits for a long-running query, every writer
# on the instance queues behind it, so this is the longest the dump can stall
# the instance. mysqldump has no option to set the session's lock wait, so a
# second connection enforces it.
LOCK_WAIT_BOUND_SECONDS = 2.0
LOCK_WATCHDOG_POLL_SECONDS = 0.2


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


class LockWaitWatchdog:
    """Kills the dump's own `FLUSH ...` statement once it has been waiting
    for `bound` seconds. Killing the statement makes mysqldump exit nonzero,
    which drops the pending global lock and releases every queued writer;
    the account may kill its own threads with no extra privilege. Used as a
    context manager around the mysqldump process. If the watchdog cannot
    reach the server on its last poll, `error` is set and the caller must
    treat the bound as unenforced."""

    def __init__(
        self,
        *,
        socket_path: str,
        password: str,
        bound: float = LOCK_WAIT_BOUND_SECONDS,
        poll: float = LOCK_WATCHDOG_POLL_SECONDS,
        run=subprocess.run,
        clock=time.monotonic,
    ) -> None:
        self._socket_path = socket_path
        self._password = password
        self._bound = bound
        self._poll = poll
        self._run = run
        self._clock = clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.killed: list[int] = []
        self.error: str | None = None

    def _waiting_flushes(self) -> list[int]:
        out = _run_mysql(
            "SELECT ID FROM information_schema.PROCESSLIST "
            f"WHERE USER = '{DUMP_MYSQL_USER}' AND INFO LIKE 'FLUSH%'",
            socket_path=self._socket_path,
            password=self._password,
            run=self._run,
        )
        return [int(line) for line in out.split() if line.strip().isdigit()]

    def _poll_once(self, first_seen: dict[int, float]) -> None:
        current = set(self._waiting_flushes())
        for thread_id in list(first_seen):
            if thread_id not in current:
                del first_seen[thread_id]
        now = self._clock()
        for thread_id in current:
            first_seen.setdefault(thread_id, now)
            if now - first_seen[thread_id] >= self._bound:
                self.killed.append(thread_id)
                del first_seen[thread_id]
                _run_mysql(
                    f"KILL QUERY {thread_id}",
                    socket_path=self._socket_path,
                    password=self._password,
                    run=self._run,
                )

    def _watch(self) -> None:
        first_seen: dict[int, float] = {}
        while not self._stop.wait(self._poll):
            try:
                self._poll_once(first_seen)
                self.error = None
            except (DumpError, OSError) as exc:
                self.error = str(exc)

    def __enter__(self) -> "LockWaitWatchdog":
        self._thread = threading.Thread(target=self._watch, name="lock-wait-watchdog", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()


def run_mysqldump(
    *,
    socket_path: str,
    password: str,
    db_name: str,
    stdout,
    popen=subprocess.Popen,
    run=subprocess.run,
    lock_wait_bound: float = LOCK_WAIT_BOUND_SECONDS,
) -> set[str]:
    """The floor check that actually matters: streams mysqldump's stdout,
    watching for an `INSERT` naming each floor table -- proof against what
    the dump actually wrote, not the source it read from. Returns the set
    of floor tables seen. See dump_tenant.md#floor-check."""
    patterns = {table: f"INSERT INTO `{table}` VALUES".encode() for table in FLOOR_TABLES}
    seen: set[str] = set()

    watchdog = LockWaitWatchdog(socket_path=socket_path, password=password, bound=lock_wait_bound, run=run)
    with tempfile.TemporaryFile() as stderr_file, watchdog:
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
            aborted = (
                f" (its lock wait exceeded {lock_wait_bound:g}s and was aborted, no lock is held)"
                if watchdog.killed
                else ""
            )
            raise DumpError(f"mysqldump exited {returncode}{aborted}: {stderr_bytes.decode(errors='replace')}")

    if watchdog.error is not None:
        raise DumpError(
            f"the lock-wait watchdog could not reach the server, so the {lock_wait_bound:g}s bound "
            f"was not enforced: {watchdog.error}"
        )

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
    run_mysqldump(
        socket_path=socket_path, password=password, db_name=db_name, stdout=stdout, popen=popen, run=run
    )
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

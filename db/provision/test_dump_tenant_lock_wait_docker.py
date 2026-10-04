#!/usr/bin/env python3
"""Proof against a real MySQL server that the per-tenant dump cannot hold
the instance's writers for longer than its lock-wait bound.

A long query holds a table open, which makes the dump's `FLUSH TABLES WITH
READ LOCK` wait, and every writer queues behind that wait. The dump must give
up within the bound, fail loudly, and leave writes flowing. Skipped when
Docker or the server image is unavailable; set DUMP_LOCK_TEST_IMAGE to
override the image.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import threading
import time
import unittest
import uuid

import dump_tenant as dt

IMAGE = os.environ.get("DUMP_LOCK_TEST_IMAGE", "mysql:8.0")
SOCKET = "/var/run/mysqld/mysqld.sock"
ROOT_PASSWORD = "root-test-password"
DUMP_PASSWORD = "dump-test-password"
LONG_QUERY_SECONDS = 12
STALL_CEILING_SECONDS = dt.LOCK_WAIT_BOUND_SECONDS + 3.0


def _docker(*args, **kwargs):
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=False, **kwargs)


class _Container:
    def __init__(self) -> None:
        self.name = f"dump-lock-test-{uuid.uuid4().hex[:8]}"

    def start(self) -> None:
        started = _docker("run", "-d", "--name", self.name, "-e", f"MYSQL_ROOT_PASSWORD={ROOT_PASSWORD}", IMAGE)
        if started.returncode != 0:
            raise unittest.SkipTest(f"cannot start {IMAGE}: {started.stderr.strip()}")
        for _ in range(90):
            ping = self.root("SELECT 1")
            if ping.returncode == 0:
                time.sleep(1)
                if self.root("SELECT 1").returncode == 0:
                    return
            time.sleep(1)
        raise RuntimeError("mysql never became ready")

    def stop(self) -> None:
        _docker("rm", "-f", self.name)

    def root(self, sql: str) -> subprocess.CompletedProcess:
        return _docker("exec", "-e", f"MYSQL_PWD={ROOT_PASSWORD}", self.name, "mysql", "-uroot", "-N", "-B", "-e", sql)

    def root_popen(self, sql: str) -> subprocess.Popen:
        return subprocess.Popen(
            ["docker", "exec", "-e", f"MYSQL_PWD={ROOT_PASSWORD}", self.name, "mysql", "-uroot", "-e", sql],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def as_dump_account(self, argv, env=None, **kwargs):
        """The dump's own commands, executed inside the container so the
        server's real mysqldump and mysql clients speak to its socket."""
        env_args = [item for key, value in (env or {}).items() if key == "MYSQL_PWD" for item in ("-e", f"{key}={value}")]
        return ["docker", "exec", "-i", *env_args, self.name, *argv]

    def run(self, argv, env=None, **kwargs):
        return subprocess.run(self.as_dump_account(argv, env), **kwargs)

    def popen(self, argv, env=None, **kwargs):
        return subprocess.Popen(self.as_dump_account(argv, env), **kwargs)


class _Writer(threading.Thread):
    """Inserts one row at a time into a table other than the one being held,
    recording how long each insert took -- a stall shows as one slow insert."""

    def __init__(self, container: _Container) -> None:
        super().__init__(daemon=True)
        self.container = container
        self.latencies: list[float] = []
        self.halt = threading.Event()

    def run(self) -> None:
        while not self.halt.is_set():
            began = time.monotonic()
            result = self.container.root("INSERT INTO ghost_blog.posts (title) VALUES ('p')")
            if result.returncode == 0:
                self.latencies.append(time.monotonic() - began)
            time.sleep(0.05)

    def finish(self) -> list[float]:
        self.halt.set()
        self.join(timeout=30)
        return self.latencies


@unittest.skipUnless(shutil.which("docker"), "docker is not available")
class DumpLockWaitAgainstRealMysqlTests(unittest.TestCase):
    container: _Container

    @classmethod
    def setUpClass(cls) -> None:
        cls.container = _Container()
        cls.container.start()
        setup = cls.container.root(
            "CREATE DATABASE ghost_blog;"
            "CREATE TABLE ghost_blog.users (id INT PRIMARY KEY, name VARCHAR(20));"
            "CREATE TABLE ghost_blog.settings (id INT PRIMARY KEY, v VARCHAR(20));"
            "CREATE TABLE ghost_blog.posts (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(20));"
            "INSERT INTO ghost_blog.users VALUES (1, 'owner');"
            "INSERT INTO ghost_blog.settings VALUES (1, 'a');"
            f"CREATE USER 'backup'@'localhost' IDENTIFIED BY '{DUMP_PASSWORD}';"
            "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, RELOAD, REPLICATION CLIENT "
            "ON *.* TO 'backup'@'localhost';"
        )
        if setup.returncode != 0:
            raise RuntimeError(setup.stderr)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.container.stop()

    def _dump(self, bound=None):
        kwargs = {} if bound is None else {"lock_wait_bound": bound}
        began = time.monotonic()
        error = None
        try:
            dt.run_mysqldump(
                socket_path=SOCKET,
                password=DUMP_PASSWORD,
                db_name="ghost_blog",
                stdout=io.BytesIO(),
                popen=self.container.popen,
                run=self.container.run,
                **kwargs,
            )
        except dt.DumpError as exc:
            error = exc
        return time.monotonic() - began, error

    def _backup_flush_threads(self) -> str:
        return self.container.root(
            "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = 'backup' AND INFO LIKE 'FLUSH%'"
        ).stdout.strip()

    def _release_long_query(self, holder: subprocess.Popen) -> None:
        """Ends the server-side query; killing the client alone does not."""
        ids = self.container.root(
            "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP%'"
        ).stdout.split()
        for thread_id in ids:
            self.container.root(f"KILL CONNECTION {thread_id}")
        holder.kill()
        holder.wait()

    def _hold_long_query(self) -> subprocess.Popen:
        holder = self.container.root_popen(
            f"SELECT SLEEP({LONG_QUERY_SECONDS}) FROM ghost_blog.settings"
        )
        for _ in range(50):
            running = self.container.root(
                "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP%'"
            )
            if running.stdout.strip() not in ("", "0"):
                break
            time.sleep(0.1)
        return holder

    def test_with_nothing_held_the_dump_succeeds(self):
        elapsed, error = self._dump()
        self.assertIsNone(error)

    def test_a_long_query_makes_the_dump_give_up_within_the_bound_and_writers_keep_going(self):
        holder = self._hold_long_query()
        writer = _Writer(self.container)
        writer.start()
        try:
            elapsed, error = self._dump()
            self.assertIsNotNone(error, "the dump waited out the long query instead of giving up")
            self.assertIn("lock wait exceeded", str(error))
            self.assertLess(elapsed, STALL_CEILING_SECONDS)

            self.assertEqual(self._backup_flush_threads(), "0")
            began = time.monotonic()
            after = self.container.root("INSERT INTO ghost_blog.posts (title) VALUES ('after')")
            self.assertEqual(after.returncode, 0)
            self.assertLess(time.monotonic() - began, 1.5, "a write after the abort was still blocked")
            self.assertIsNone(holder.poll(), "the long query ended early, so nothing was proved")
        finally:
            latencies = writer.finish()
            self._release_long_query(holder)

        self.assertGreater(len(latencies), 3)
        self.assertLess(
            max(latencies),
            STALL_CEILING_SECONDS,
            f"a writer was stalled {max(latencies):.1f}s, past the {dt.LOCK_WAIT_BOUND_SECONDS:g}s bound",
        )

    def test_a_global_read_lock_stuck_behind_a_long_query_is_killed_and_writers_resume(self):
        """mysqldump's second statement, `FLUSH TABLES WITH READ LOCK`, is the
        one that stalls writers: it holds the global lock while it waits. It
        runs there only when a long query starts after the first, lock-free
        `FLUSH LOCAL TABLES` has passed, a gap too narrow to hit on demand, so
        this issues that exact statement from the dump account."""
        holder = self._hold_long_query()
        writer = _Writer(self.container)
        writer.start()
        statement = "FLUSH TABLES WITH READ LOCK; SELECT SLEEP(60)"
        began = time.monotonic()
        watchdog = dt.LockWaitWatchdog(
            socket_path=SOCKET, password=DUMP_PASSWORD, run=self.container.run
        )
        try:
            with watchdog:
                locker = self.container.popen(
                    ["mysql", "--socket", SOCKET, "--user", dt.DUMP_MYSQL_USER, "-e", statement],
                    env={"MYSQL_PWD": DUMP_PASSWORD},
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                try:
                    exit_code = locker.wait(timeout=LONG_QUERY_SECONDS + 10)
                except subprocess.TimeoutExpired:
                    locker.kill()
                    exit_code = None
            elapsed = time.monotonic() - began
            self.assertIsNotNone(exit_code, "the global read lock was never given up")
            self.assertNotEqual(exit_code, 0)
            self.assertEqual(len(watchdog.killed), 1)
            self.assertLess(elapsed, STALL_CEILING_SECONDS)
            self.assertEqual(self._backup_flush_threads(), "0")
            self.assertIsNone(holder.poll(), "the long query ended early, so nothing was proved")
        finally:
            latencies = writer.finish()
            self._release_long_query(holder)

        self.assertLess(max(latencies), STALL_CEILING_SECONDS, f"a writer was stalled {max(latencies):.1f}s")
        self.assertGreater(max(latencies), 0.5, "no stall was seen, so the lock was never contended")

    def test_the_dump_works_again_once_the_long_query_ends(self):
        holder = self._hold_long_query()
        _, error = self._dump()
        self.assertIsNotNone(error)
        holder.kill()
        holder.wait()
        self.container.root("KILL QUERY 0") if False else None
        for _ in range(50):
            if self.container.root(
                "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP%'"
            ).stdout.strip() == "0":
                break
            time.sleep(0.2)
        _, error = self._dump()
        self.assertIsNone(error)


if __name__ == "__main__":
    unittest.main()

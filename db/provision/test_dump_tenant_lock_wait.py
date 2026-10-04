#!/usr/bin/env python3
"""Unit tests for dump_tenant.py's lock-wait watchdog, with no database.

The real-server proof is test_dump_tenant_lock_wait_docker.py.
"""

from __future__ import annotations

import io
import subprocess
import time
import unittest

import dump_tenant as dt


class ScriptedMysql:
    """Answers the watchdog's two statements: the thread listing, from a
    scripted sequence, and KILL QUERY, which it records."""

    def __init__(self, listings, fail=False):
        self.listings = list(listings)
        self.fail = fail
        self.kills = []
        self.sql = []

    def __call__(self, argv, env=None, capture_output=None, text=None, check=None):
        statement = argv[-1]
        self.sql.append(statement)
        if self.fail:
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="gone")
        if statement.startswith("KILL QUERY"):
            self.kills.append(int(statement.split()[-1]))
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        out = self.listings.pop(0) if self.listings else ""
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def make(run, clock, bound=2.0):
    return dt.LockWaitWatchdog(socket_path="/tmp/s", password="pw", bound=bound, run=run, clock=clock)


class WatchdogPollTests(unittest.TestCase):
    def test_does_not_kill_a_flush_before_the_bound(self):
        run, clock = ScriptedMysql(["7\n", "7\n"]), Clock()
        watchdog, seen = make(run, clock), {}
        watchdog._poll_once(seen)
        clock.now = 1.9
        watchdog._poll_once(seen)
        self.assertEqual(run.kills, [])

    def test_kills_a_flush_that_has_waited_the_bound(self):
        run, clock = ScriptedMysql(["7\n", "7\n"]), Clock()
        watchdog, seen = make(run, clock), {}
        watchdog._poll_once(seen)
        clock.now = 2.0
        watchdog._poll_once(seen)
        self.assertEqual(run.kills, [7])
        self.assertEqual(watchdog.killed, [7])

    def test_a_flush_that_finishes_resets_its_clock(self):
        run, clock = ScriptedMysql(["7\n", "", "7\n", "7\n"]), Clock()
        watchdog, seen = make(run, clock), {}
        for now in (0.0, 1.5, 3.0, 4.9):
            clock.now = now
            watchdog._poll_once(seen)
        self.assertEqual(run.kills, [])

    def test_listing_only_selects_the_backup_accounts_flush_statements(self):
        run = ScriptedMysql([""])
        make(run, Clock())._poll_once({})
        self.assertIn("USER = 'backup'", run.sql[0])
        self.assertIn("LIKE 'FLUSH%'", run.sql[0])

    def test_an_unreachable_server_is_recorded_not_swallowed(self):
        watchdog = make(ScriptedMysql([], fail=True), Clock())
        with self.assertRaises(dt.DumpError):
            watchdog._poll_once({})

    def test_the_background_thread_polls_and_stops_on_exit(self):
        run = ScriptedMysql(["7\n"] * 1000)
        watchdog = dt.LockWaitWatchdog(
            socket_path="/tmp/s", password="pw", bound=0.0, poll=0.01, run=run
        )
        with watchdog:
            for _ in range(200):
                if watchdog.killed:
                    break
                time.sleep(0.01)
        self.assertTrue(watchdog.killed)
        self.assertFalse(watchdog._thread.is_alive())

    def test_the_background_thread_records_an_unreachable_server(self):
        watchdog = dt.LockWaitWatchdog(
            socket_path="/tmp/s", password="pw", poll=0.01, run=ScriptedMysql([], fail=True)
        )
        with watchdog:
            for _ in range(200):
                if watchdog.error:
                    break
                time.sleep(0.01)
        self.assertIn("gone", watchdog.error)

    def test_a_missing_mysql_binary_is_recorded_too(self):
        def missing(*args, **kwargs):
            raise FileNotFoundError("mysql")

        watchdog = dt.LockWaitWatchdog(socket_path="/tmp/s", password="pw", poll=0.01, run=missing)
        with watchdog:
            for _ in range(200):
                if watchdog.error:
                    break
                time.sleep(0.01)
        self.assertIn("mysql", watchdog.error)


class _Process:
    def __init__(self, returncode):
        self.stdout = io.BytesIO(b"")
        self._returncode = returncode

    def wait(self):
        return self._returncode


class DumpErrorReportingTests(unittest.TestCase):
    def test_a_killed_lock_wait_is_named_in_the_error(self):
        class Killed(dt.LockWaitWatchdog):
            def __enter__(self):
                self.killed.append(9)
                return self

        original = dt.LockWaitWatchdog
        dt.LockWaitWatchdog = Killed
        try:
            with self.assertRaises(dt.DumpError) as caught:
                dt.run_mysqldump(
                    socket_path="/tmp/s",
                    password="pw",
                    db_name="ghost_blog",
                    stdout=io.BytesIO(),
                    popen=lambda *a, **k: _Process(2),
                )
        finally:
            dt.LockWaitWatchdog = original
        self.assertIn("lock wait exceeded", str(caught.exception))

    def test_a_dump_whose_watchdog_never_reached_the_server_fails(self):
        class Blind(dt.LockWaitWatchdog):
            def __enter__(self):
                self.error = "no route"
                return self

        original = dt.LockWaitWatchdog
        dt.LockWaitWatchdog = Blind
        lines = b"INSERT INTO `users` VALUES (1);\nINSERT INTO `settings` VALUES (1);\n"

        class Fine(_Process):
            def __init__(self):
                super().__init__(0)
                self.stdout = io.BytesIO(lines)

        try:
            with self.assertRaises(dt.DumpError) as caught:
                dt.run_mysqldump(
                    socket_path="/tmp/s",
                    password="pw",
                    db_name="ghost_blog",
                    stdout=io.BytesIO(),
                    popen=lambda *a, **k: Fine(),
                )
        finally:
            dt.LockWaitWatchdog = original
        self.assertIn("not enforced", str(caught.exception))


if __name__ == "__main__":
    unittest.main()

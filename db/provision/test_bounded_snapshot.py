#!/usr/bin/env python3
"""Unit tests for bounded_snapshot.py, against fake `mysql` and `mysqldump`
executables run as real processes (fake_mysql_clients.py). The real-server
proof is infra/provisioning/scripts/test_backup_lock_bound_docker.py."""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import bounded_snapshot as bs
import extract_tenant_binlog
from fake_mysql_clients import FakeMysqlClients

FAST = bs.Limits(
    wait_deadline_seconds=0.8,
    hold_bound_seconds=1.5,
    max_attempts=3,
    backoff_seconds=(0.0,),
    setup_timeout_seconds=10.0,
    release_timeout_seconds=3.0,
)


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.fakes = FakeMysqlClients(tmp.name)
        self.factory = bs.ClientFactory(
            connection_args=["--host", "db.internal", "--user", "dumper"],
            password="s3cret-pw",
            env={"PATH": tmp.name + os.pathsep + os.environ.get("PATH", "")},
        )
        self.sleeps: list[float] = []

    def snapshot(self, limits: bs.Limits = FAST, schemas=("ghost_blog",)):
        dump, report = bs.take_bounded_snapshot(
            factory=self.factory,
            schemas=list(schemas) if schemas is not None else None,
            dump_args=["--single-transaction", "--databases", "ghost_blog"],
            limits=limits,
            sleep=self.sleeps.append,
        )
        self.addCleanup(self._reap, dump.process)
        return dump, report

    @staticmethod
    def _reap(process) -> None:
        bs.kill_process(process)
        process.wait()
        process.stdout.close()

    def snapshot_error(self, limits: bs.Limits = FAST) -> bs.SnapshotError:
        with self.assertRaises(bs.SnapshotError) as ctx:
            self.snapshot(limits)
        return ctx.exception


class SuccessTests(_Fixture):
    def test_reports_the_position_and_measurements(self) -> None:
        dump, report = self.snapshot()
        self.assertEqual((report.log_file, report.log_position), ("mysql-bin.000007", 1234))
        self.assertEqual((report.attempts, report.aborted_attempts, report.tables_locked), (1, 0, 2))
        self.assertGreaterEqual(report.lock_wait_seconds, 0.0)
        self.assertGreater(report.hold_seconds, 0.0)
        self.assertLess(report.hold_seconds, FAST.hold_bound_seconds)
        self.assertEqual(dump.process.stdout.read(), b"-- dump content\n")
        self.assertEqual(dump.process.wait(), 0)

    def test_the_session_is_bounded_before_anything_is_locked(self) -> None:
        self.snapshot()
        statements = self.fakes.statements()
        lock = next(i for i, s in enumerate(statements) if s.startswith("LOCK TABLES"))
        self.assertIn("SET SESSION lock_wait_timeout = 1", statements[:lock])
        self.assertIn("SET SESSION wait_timeout = 2", statements[:lock])

    def test_locks_exactly_the_listed_tables_read(self) -> None:
        self.snapshot()
        locks = [s for s in self.fakes.statements() if s.startswith("LOCK TABLES")]
        self.assertEqual(locks, ["LOCK TABLES `ghost_blog`.`settings` READ, `ghost_blog`.`users` READ"])

    def test_never_flushes_tables(self) -> None:
        self.snapshot()
        self.assertFalse([s for s in self.fakes.statements() if "FLUSH" in s.upper()])

    def test_the_dump_starts_after_the_position_is_read_and_before_the_unlock(self) -> None:
        self.snapshot()
        events = self.fakes.events()
        position_read = next(e["t"] for e in events if e.get("sql", "").startswith("SELECT LOCAL"))
        dump_start = next(e["t"] for e in events if e["kind"] == "start" and e["binary"] == "mysqldump")
        unlock = next(e["t"] for e in events if e.get("sql") == "UNLOCK TABLES")
        self.assertLess(position_read, dump_start)
        self.assertLess(dump_start, unlock)

    def test_the_dump_runs_verbose_with_the_callers_arguments(self) -> None:
        self.snapshot()
        argv = self.fakes.starts("mysqldump")[0]["argv"]
        self.assertEqual(argv[-4:], ["-v", "--single-transaction", "--databases", "ghost_blog"])
        self.assertNotIn("--source-data=2", argv)

    def test_the_password_travels_only_through_the_option_file(self) -> None:
        self.snapshot()
        for start in self.fakes.events():
            if start["kind"] != "start":
                continue
            self.assertEqual(start["password"], "[client]\npassword=s3cret-pw\n")
            self.assertFalse(any("s3cret-pw" in arg for arg in start["argv"]))
            self.assertNotIn("MYSQL_PWD", start["environ"])
            self.assertTrue(start["argv"][0].startswith("--defaults-extra-file=/dev/fd/"))

    def test_no_kill_is_issued_on_success(self) -> None:
        self.snapshot()
        self.assertEqual(self.fakes.kills(), [])

    def test_every_user_schema_when_none_is_named(self) -> None:
        self.snapshot(schemas=None)
        listing = next(s for s in self.fakes.statements() if s.startswith("SELECT TABLE_SCHEMA"))
        self.assertIn("TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')", listing)

    def test_the_comment_is_the_form_extract_tenant_binlog_parses(self) -> None:
        _, report = self.snapshot()
        line = report.coordinates_comment().decode().rstrip("\n")
        match = extract_tenant_binlog.SOURCE_DATA_PATTERN.match(line)
        self.assertIsNotNone(match)
        self.assertEqual((match.group("log_file"), match.group("position")), ("mysql-bin.000007", "1234"))


class WaitBoundTests(_Fixture):
    def test_a_server_lock_timeout_is_retried_after_a_back_off(self) -> None:
        self.fakes.configure(lock=["timeout", "ok"])
        _, report = self.snapshot()
        self.assertEqual((report.attempts, report.aborted_attempts), (2, 1))
        self.assertEqual(self.sleeps, [0.0])
        self.assertEqual(self.fakes.kills(), ["KILL CONNECTION 42"])

    def test_gives_up_loudly_after_the_last_attempt(self) -> None:
        self.fakes.configure(lock=["timeout"])
        error = self.snapshot_error()
        self.assertEqual((error.attempts, error.aborted_attempts), (3, 3))
        self.assertIn("each given up on a lock bound", str(error))
        self.assertEqual(len(self.sleeps), 2)

    def test_the_back_off_follows_the_configured_steps(self) -> None:
        self.fakes.configure(lock=["timeout"])
        with self.assertRaises(bs.SnapshotError):
            self.snapshot(bs.Limits(**{**FAST.__dict__, "backoff_seconds": (0.01, 0.02)}))
        self.assertEqual(self.sleeps, [0.01, 0.02])

    def test_a_lock_the_server_never_answers_is_killed_at_the_client_deadline(self) -> None:
        self.fakes.configure(lock=["hang", "ok"])
        began = time.monotonic()
        _, report = self.snapshot()
        self.assertLess(time.monotonic() - began, FAST.wait_deadline_seconds + 3.0)
        self.assertEqual(report.aborted_attempts, 1)
        self.assertEqual(self.fakes.kills(), ["KILL CONNECTION 42"])

    def test_a_lock_error_other_than_a_timeout_is_not_retried(self) -> None:
        self.fakes.configure(lock=["error"])
        error = self.snapshot_error()
        self.assertEqual((error.attempts, error.aborted_attempts), (1, 0))
        self.assertIn("1227", str(error))


class HoldBoundTests(_Fixture):
    def test_a_snapshot_not_open_within_the_hold_bound_is_aborted(self) -> None:
        self.fakes.configure(marker_delay=5)
        began = time.monotonic()
        error = self.snapshot_error()
        elapsed = time.monotonic() - began
        self.assertEqual(error.aborted_attempts, 3)
        self.assertIn("hold bound", str(error))
        self.assertLess(elapsed, 3 * (FAST.hold_bound_seconds + 2.0))
        self.assertEqual(self.fakes.kills(), ["KILL CONNECTION 42"] * 3)

    def test_the_aborted_dump_is_killed(self) -> None:
        self.fakes.configure(marker_delay=5)
        self.snapshot_error()
        time.sleep(0.3)
        exits = [e for e in self.fakes.events() if e["kind"] == "exit" and e["binary"] == "mysqldump"]
        self.assertEqual(exits, [])

    def test_a_dump_that_ends_before_its_snapshot_is_aborted(self) -> None:
        self.fakes.configure(marker=False, dump_exit=2, dump_stderr=["mysqldump: Got error: 1044"])
        error = self.snapshot_error()
        self.assertIn("ended before opening its snapshot", str(error))
        self.assertIn("1044", str(error))

    def test_an_unlock_the_server_never_confirms_is_killed(self) -> None:
        self.fakes.configure(unlock="hang")
        error = self.snapshot_error()
        self.assertIn("hold bound", str(error))
        self.assertEqual(len(self.fakes.kills()), 3)

    def test_a_changed_table_set_is_aborted(self) -> None:
        self.fakes.configure(tables_under_lock=[["ghost_blog", "settings"]])
        error = self.snapshot_error()
        self.assertIn("set of tables changed", str(error))


class ReleaseTests(_Fixture):
    def test_an_unconfirmed_release_stops_the_run(self) -> None:
        self.fakes.configure(lock=["timeout", "ok"], kill="fail")
        error = self.snapshot_error()
        self.assertEqual((error.attempts, error.aborted_attempts), (1, 0))
        self.assertIn("could not confirm", str(error))

    def test_a_kill_that_hangs_is_given_up_on_and_stops_the_run(self) -> None:
        self.fakes.configure(lock=["timeout", "ok"], kill="hang")
        limits = bs.Limits(**{**FAST.__dict__, "release_timeout_seconds": 0.5})
        began = time.monotonic()
        error = self.snapshot_error(limits)
        self.assertLess(time.monotonic() - began, 5.0)
        self.assertIn("could not confirm", str(error))

    def test_a_session_already_gone_counts_as_released(self) -> None:
        self.fakes.configure(lock=["timeout", "ok"], kill="unknown")
        _, report = self.snapshot()
        self.assertEqual(report.aborted_attempts, 1)


class SetupFailureTests(_Fixture):
    def test_a_refused_connection_is_not_retried(self) -> None:
        self.fakes.configure(connect="fail")
        error = self.snapshot_error()
        self.assertEqual(error.attempts, 1)
        self.assertIn("1045", str(error))
        self.assertEqual(len(self.fakes.starts("mysql")), 1)

    def test_no_tables_is_refused(self) -> None:
        self.fakes.configure(tables=[])
        error = self.snapshot_error()
        self.assertIn("no base tables", str(error))

    def test_a_server_without_a_binary_log_is_refused(self) -> None:
        self.fakes.configure(log_status='{"binary_log_file": "", "binary_log_position": 0}')
        self.assertIn("log_bin", str(self.snapshot_error()))

    def test_an_unreadable_position_is_refused(self) -> None:
        self.fakes.configure(log_status="{}")
        self.assertIn("no binary-log position", str(self.snapshot_error()))

    def test_a_setup_that_never_answers_is_given_up_on(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]])
        limits = bs.Limits(**{**FAST.__dict__, "setup_timeout_seconds": 0.0})
        self.assertIn("setup failed", str(self.snapshot_error(limits)))


class PureFunctionTests(unittest.TestCase):
    def test_identifiers_are_quoted(self) -> None:
        self.assertEqual(bs.lock_tables_sql([("a`b", "c")]), "LOCK TABLES `a``b`.`c` READ;")

    def test_strings_are_quoted(self) -> None:
        self.assertIn("IN ('it''s', 'a\\\\b')", bs.list_tables_sql(["it's", "a\\b"]))

    def test_log_status_needs_exactly_one_row(self) -> None:
        with self.assertRaises(bs._Fatal):
            bs.parse_log_status([])

    def test_the_default_bounds_keep_a_writer_under_two_seconds(self) -> None:
        limits = bs.Limits()
        self.assertLess(limits.wait_deadline_seconds + limits.hold_bound_seconds, 2.0)
        self.assertLessEqual(limits.lock_wait_timeout_seconds, limits.wait_deadline_seconds)
        self.assertGreaterEqual(limits.lock_wait_timeout_seconds, 1)
        self.assertGreater(limits.server_idle_backstop_seconds, limits.hold_bound_seconds)

    def test_kill_process_survives_a_process_that_is_already_gone(self) -> None:
        process = subprocess.Popen(["true"])
        process.wait()
        bs.kill_process(process)
        bs.kill_process(mock.Mock(pid=None, kill=mock.Mock(side_effect=ProcessLookupError)))

    def test_the_factory_closes_its_copy_of_the_password_pipe(self) -> None:
        opened = []

        def fake_popen(argv, *, env, pass_fds, **kwargs):
            opened.extend(pass_fds)
            return mock.Mock()

        bs.ClientFactory(connection_args=[], password="pw", env={}, popen=fake_popen).spawn("mysql", [])
        with self.assertRaises(OSError):
            os.fstat(opened[0])


if __name__ == "__main__":
    unittest.main()

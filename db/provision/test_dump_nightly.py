#!/usr/bin/env python3
"""Unit tests for dump_nightly.py.

Every external command is faked -- no real mysqldump, age or network call --
so these assert the pipeline's ordering and failure handling: a failed stage
must stop the pipeline rather than uploading a partial or missing artifact,
and nothing plaintext must survive the run.
"""

import contextlib
import datetime
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
from typing import ClassVar
from unittest import mock

import bounded_snapshot as bs
import dump_nightly as dn
import extract_tenant_binlog as etb
from fake_mysql_clients import FakeMysqlClients

FAST = bs.Limits(hold_bound_seconds=1.5, max_attempts=3, backoff_seconds=(0.0,))

FAKE_SERVER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

POSITION_7_1234 = json.dumps({"binary_log_file": "mysql-bin.000007", "binary_log_position": 1234})
POSITION_8_500 = json.dumps({"binary_log_file": "mysql-bin.000008", "binary_log_position": 500})


class FakeRun:
    """Writes plausible output for mysql/mysqldump/age so the pipeline has
    real bytes and a real server_uuid to carry forward, without invoking any
    real binary."""

    def __init__(self, fail_command=None, server_uuid=FAKE_SERVER_UUID):
        self.calls = []
        self.fail_command = fail_command
        self.server_uuid = server_uuid

    def __call__(self, argv, env=None, stdout=None, stderr=None, capture_output=None, text=None, check=None):
        self.calls.append(list(argv))
        command = argv[0]
        if command == self.fail_command:
            return subprocess.CompletedProcess(argv, 1, stdout="" if text else b"", stderr="boom" if text else b"boom")

        if command == "mysql":
            return subprocess.CompletedProcess(argv, 0, stdout=f"{self.server_uuid}\n", stderr="")

        if command == "mysqldump":
            stdout.write(b"-- dump content\n")
            return subprocess.CompletedProcess(argv, 0, stderr=b"")

        if command == "age":
            out_path = argv[argv.index("-o") + 1]
            in_path = argv[-1]
            with open(in_path, "rb") as src, open(out_path, "wb") as dst:
                dst.write(b"AGE-ENCRYPTED:" + src.read())
            return subprocess.CompletedProcess(argv, 0, stderr=b"")

        raise AssertionError(f"unexpected command: {command}")


class GetServerUuidTests(unittest.TestCase):
    def test_reads_the_server_uuid(self):
        run = FakeRun()
        self.assertEqual(dn.get_server_uuid(socket_path="/tmp/mysqld.sock", password="pw", run=run), FAKE_SERVER_UUID)

    def test_raises_on_empty_output(self):
        run = FakeRun(server_uuid="")
        with self.assertRaises(dn.DumpError):
            dn.get_server_uuid(socket_path="/tmp/mysqld.sock", password="pw", run=run)

    def test_never_passes_the_password_as_an_argument(self):
        run = FakeRun()
        dn.get_server_uuid(socket_path="/tmp/mysqld.sock", password="super-secret", run=run)
        for call in run.calls:
            self.assertNotIn("super-secret", call)


class _FakeClientsOnPath(unittest.TestCase):
    """The real mysql and mysqldump are replaced by fake_mysql_clients.py's
    fakes on PATH: run_mysqldump drives them through bounded_snapshot."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.fakes = FakeMysqlClients(tmp.name)
        self.fakes.configure(tables=[["ghost_blog", "users"], ["ghost_shop", "users"]])
        patcher = mock.patch.dict(os.environ, {"PATH": tmp.name + os.pathsep + os.environ.get("PATH", "")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.out_path = os.path.join(tmp.name, "dump.sql")


class RunMysqldumpTests(_FakeClientsOnPath):
    def _dump(self, **overrides):
        kwargs = dict(socket_path="/tmp/mysqld.sock", password="pw", out_path=self.out_path, limits=FAST, sleep=lambda s: None)
        kwargs.update(overrides)
        return dn.run_mysqldump(**kwargs)

    def test_writes_each_schemas_own_resume_comment_then_its_dump(self):
        self.fakes.configure(
            tables=[["ghost_blog", "users"], ["ghost_shop", "users"]],
            log_status_sequence=[POSITION_7_1234, POSITION_8_500],
        )
        self._dump()
        with open(self.out_path, "rb") as f:
            self.assertEqual(
                f.read(),
                b"-- BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000007', MASTER_LOG_POS=1234;\n"
                b"-- dump content\n"
                b"-- BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000008', MASTER_LOG_POS=500;\n"
                b"-- dump content\n",
            )

    def test_never_writes_the_one_bare_resume_comment_a_whole_dump_would_carry(self):
        # A reader that only knows the bare form must find none, and refuse,
        # rather than replay every schema from the first schema's position.
        self._dump()
        with open(self.out_path, "rb") as f:
            self.assertNotIn(b"\n-- CHANGE MASTER TO", b"\n" + f.read())

    def test_dumps_every_database_without_source_data(self):
        self._dump()
        starts = self.fakes.starts("mysqldump")
        databases = []
        for start in starts:
            argv = start["argv"]
            self.assertIn("--single-transaction", argv)
            self.assertNotIn("--source-data=2", argv)
            self.assertNotIn("--all-databases", argv)
            databases += argv[argv.index("--databases") + 1 :]
        self.assertEqual(sorted(databases), ["ghost_blog", "ghost_shop", "mysql", "sys"])

    def test_locks_each_user_schema_in_its_own_statement_and_never_flushes(self):
        self._dump()
        self.assertEqual(
            self.fakes.lock_statements(),
            ["LOCK TABLES `ghost_blog`.`users` READ", "LOCK TABLES `ghost_shop`.`users` READ"],
        )
        self.assertFalse([s for s in self.fakes.statements() if "FLUSH" in s.upper()])

    def test_no_lock_statement_ever_names_tables_of_two_schemas(self):
        self.fakes.configure(
            tables=[["ghost_a", "t1"], ["ghost_a", "t2"], ["ghost_b", "t1"], ["ghost_c", "t1"]]
        )
        self._dump()
        for statement in self.fakes.lock_statements():
            schemas = {name for name, _ in re.findall(r"`([^`]*)`\.`([^`]*)` READ", statement)}
            self.assertEqual(len(schemas), 1, statement)

    def test_the_system_schemas_and_empty_schemas_ride_in_the_first_dump(self):
        self.fakes.configure(
            tables=[["ghost_a", "t1"], ["ghost_b", "t1"]], schemas=["ghost_a", "ghost_b", "ghost_empty"]
        )
        self._dump()
        names = [start["argv"][start["argv"].index("--databases") + 1 :] for start in self.fakes.starts("mysqldump")]
        self.assertEqual(names, [["ghost_a", "ghost_empty", "mysql", "sys"], ["ghost_b"]])

    def test_the_system_schemas_are_never_locked(self):
        self._dump()
        for statement in self.fakes.lock_statements():
            self.assertNotIn("`mysql`", statement)
            self.assertNotIn("`sys`", statement)

    def test_a_schema_with_no_base_tables_and_no_other_is_refused(self):
        self.fakes.configure(tables=[], schemas=["ghost_empty"])
        with self.assertRaises(dn.DumpError):
            self._dump()
        self.assertFalse(os.path.exists(self.out_path))

    def test_a_schema_name_that_looks_like_an_option_is_refused_before_anything_starts(self):
        self.fakes.configure(tables=[["--all-databases", "t"]])
        with self.assertRaises(dn.DumpError):
            self._dump()
        self.assertEqual(self.fakes.starts("mysqldump"), [])

    def test_a_schema_dropped_after_it_was_listed_is_skipped_and_said_so(self):
        self.fakes.configure(
            tables_at_plan=[["ghost_a", "t1"], ["ghost_b", "t1"]],
            tables=[["ghost_a", "t1"]],
            schemas=["ghost_a", "ghost_b"],
            schemas_second=["ghost_a"],
        )
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            report = self._dump()
        self.assertEqual(report.skipped_schemas, ("ghost_b",))
        self.assertIn("ghost_b", stderr.getvalue())
        names = [start["argv"][start["argv"].index("--databases") + 1 :] for start in self.fakes.starts("mysqldump")]
        self.assertEqual(names, [["ghost_a", "mysql", "sys"]])

    def test_the_system_schemas_move_to_the_next_dump_when_the_first_schema_was_dropped(self):
        self.fakes.configure(
            tables_at_plan=[["ghost_a", "t1"], ["ghost_b", "t1"]],
            tables=[["ghost_b", "t1"]],
            schemas=["ghost_a", "ghost_b"],
            schemas_second=["ghost_b"],
        )
        with contextlib.redirect_stderr(io.StringIO()):
            self._dump()
        names = [start["argv"][start["argv"].index("--databases") + 1 :] for start in self.fakes.starts("mysqldump")]
        self.assertEqual(names, [["ghost_b", "mysql", "sys"]])

    def test_a_schema_that_still_exists_but_cannot_be_locked_fails_the_whole_run(self):
        # Skipping is only for a schema the server confirms is gone: a tenant
        # that merely stays busy must fail loudly, never fall out of the dump.
        self.fakes.configure(
            tables=[["ghost_blog", "users"], ["ghost_shop", "users"]], timeout_on=["ghost_shop", "users"], lock=["timeout"]
        )
        with self.assertRaises(dn.DumpError) as ctx:
            self._dump()
        self.assertIn("3 lock attempt(s) aborted", str(ctx.exception))

    def test_a_failed_schema_list_stops_before_any_lock(self):
        self.fakes.configure(list="fail")
        with self.assertRaises(dn.DumpError):
            self._dump()
        self.assertEqual(self.fakes.lock_statements(), [])
        self.assertFalse(os.path.exists(self.out_path))

    def test_every_dumped_database_resumes_from_the_position_of_its_own_dump(self):
        # The restore guarantee, end to end: what this run writes is what
        # extract_tenant_binlog reads back, per database.
        self.fakes.configure(
            tables=[["ghost_blog", "users"], ["ghost_shop", "users"]],
            log_status_sequence=[POSITION_7_1234, POSITION_8_500],
            dump_declares_databases=True,
        )
        self._dump()
        starts = {
            name: etb.read_dump_recovery_start(self.out_path, tenant_database=name)
            for name in ("ghost_blog", "ghost_shop", "mysql", "sys")
        }
        self.assertEqual(starts["ghost_blog"], etb.RecoveryStart("mysql-bin.000007", 1234, None))
        self.assertEqual(starts["ghost_shop"], etb.RecoveryStart("mysql-bin.000008", 500, None))
        self.assertEqual(starts["mysql"], starts["ghost_blog"])
        self.assertEqual(starts["sys"], starts["ghost_blog"])
        with self.assertRaises(etb.ExtractError):
            etb.read_dump_recovery_start(self.out_path, tenant_database="ghost_nobody")

    def test_never_passes_the_password_as_an_argument(self):
        self._dump(password="super-secret")
        for start in self.fakes.events():
            if start["kind"] == "start":
                self.assertFalse(any("super-secret" in arg for arg in start["argv"]))
                self.assertNotIn("MYSQL_PWD", start["environ"])

    def test_connects_over_the_socket_not_tcp(self):
        self._dump(socket_path="/opt/branchleft/db/run/mysqld/mysqld.sock")
        for start in self.fakes.events():
            if start["kind"] == "start":
                argv = start["argv"]
                self.assertEqual(argv[argv.index("--socket") + 1], "/opt/branchleft/db/run/mysqld/mysqld.sock")
                self.assertEqual(argv[argv.index("--user") + 1], "backup")
                self.assertNotIn("--host", argv)

    def test_raises_on_a_nonzero_exit(self):
        self.fakes.configure(dump_exit=2, dump_stderr=["mysqldump: Error 2013"])
        with self.assertRaises(dn.DumpError) as ctx:
            self._dump()
        self.assertIn("Error 2013", str(ctx.exception))

    def test_raises_when_no_snapshot_can_be_taken(self):
        self.fakes.configure(lock=["timeout"])
        with self.assertRaises(dn.DumpError) as ctx:
            self._dump()
        self.assertIn("3 lock attempt(s) aborted", str(ctx.exception))
        self.assertFalse(os.path.exists(self.out_path))

    def test_retries_a_lock_timeout_and_reports_it(self):
        self.fakes.configure(lock=["timeout", "ok"])
        report = self._dump()
        self.assertEqual(report.aborted_attempts, 1)


class ObjectKeyTests(unittest.TestCase):
    def test_format(self):
        now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)
        self.assertEqual(
            dn.object_key_for(FAKE_SERVER_UUID, now),
            f"dumps/{FAKE_SERVER_UUID}/db1-20260822T031500Z.sql.age",
        )

    def test_different_server_incarnations_never_collide(self):
        now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)
        before_rebuild = dn.object_key_for("uuid-before", now)
        after_rebuild = dn.object_key_for("uuid-after", now)
        # Same timestamp, same logical dump slot -- only the server identity
        # changed, which is exactly the host-loss/rebuild scenario.
        self.assertNotEqual(before_rebuild, after_rebuild)


class LockMetricTests(_FakeClientsOnPath):
    def _metrics(self):
        with open(os.path.join(self.tmp, "m", dn.METRICS_FILENAME), encoding="utf-8") as handle:
            return handle.read()

    def _dump(self):
        return dn.run_mysqldump(
            socket_path="/tmp/mysqld.sock", password="pw", out_path=self.out_path, limits=FAST,
            sleep=lambda s: None, metrics_dir=os.path.join(self.tmp, "m"),
        )

    def test_a_dump_publishes_wait_hold_and_a_zero_abort_counter(self):
        self._dump()
        text = self._metrics()
        self.assertIn('backup_worker_lock_wait_seconds{tenant="db1-all-databases"} ', text)
        self.assertIn('backup_worker_lock_hold_seconds{tenant="db1-all-databases"} ', text)
        self.assertIn('backup_worker_lock_aborts_total{tenant="db1-all-databases"} 0\n', text)

    def test_the_abort_counter_accumulates_across_runs_and_failures(self):
        self.fakes.configure(tables=[["ghost_blog", "users"]], lock=["timeout", "ok"])
        self._dump()
        self.fakes.configure(tables=[["ghost_blog", "users"]], lock=["timeout"])
        with self.assertRaises(dn.DumpError):
            self._dump()
        self.assertIn('backup_worker_lock_aborts_total{tenant="db1-all-databases"} 4\n', self._metrics())

    def test_a_failure_after_a_stored_section_still_publishes_its_gauges_and_every_abort(self):
        self.fakes.configure(
            tables=[["ghost_blog", "users"], ["ghost_shop", "users"]], timeout_on=["ghost_shop", "users"], lock=["timeout"]
        )
        with self.assertRaises(dn.DumpError):
            self._dump()
        text = self._metrics()
        self.assertIn('backup_worker_lock_wait_seconds{tenant="db1-all-databases"} ', text)
        self.assertIn('backup_worker_lock_aborts_total{tenant="db1-all-databases"} 3\n', text)

    def test_no_snapshot_attempt_means_no_metrics_file(self):
        self.fakes.configure(list="fail")
        with self.assertRaises(dn.DumpError):
            self._dump()
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "m")))

    def test_the_report_names_the_worst_section_and_adds_up_the_rest(self):
        def section(wait, hold, tables, attempts, aborted):
            return bs.SnapshotReport("f", 4, wait, hold, tables, attempts, aborted)

        report = dn.NightlyReport(sections=(section(0.1, 0.5, 3, 1, 0), section(0.9, 0.2, 4, 3, 2)))
        self.assertEqual(
            (report.lock_wait_seconds, report.hold_seconds, report.tables_locked, report.attempts, report.aborted_attempts),
            (0.9, 0.5, 7, 4, 2),
        )

    def test_no_metrics_dir_writes_nothing(self):
        dn.run_mysqldump(socket_path="/tmp/mysqld.sock", password="pw", out_path=self.out_path, limits=FAST, sleep=lambda s: None)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "m")))

    def test_a_write_failure_never_fails_the_dump(self):
        blocker = os.path.join(self.tmp, "file")
        with open(blocker, "w", encoding="utf-8") as handle:
            handle.write("x")
        dn.record_lock_metrics(metrics_dir=blocker, report=None, aborts=1)


class DeadlockExposureTests(_FakeClientsOnPath):
    """A model of the server's documented rule, not a MySQL run: `LOCK TABLES`
    takes its tables one at a time in name order and keeps each while it asks
    for the next, so a transaction already holding a later table and asking
    for an earlier one closes a cycle, and the server rolls the transaction
    back (error 1213) because the lock request has the heavier weight. The
    server-side proof of that is snapshot_probe.md; here the fake applies the
    same rule to whatever LOCK TABLES statements this module issues."""

    # Tenant b's writer holds one table and asks for an earlier one. Tenant c
    # is busy: locking it times out on its first two attempts.
    BUSY_C: ClassVar[dict] = {
        "tables": [["ghost_a", "t1"], ["ghost_b", "posts"], ["ghost_b", "posts_tags"], ["ghost_c", "t1"]],
        "inflight": [{"name": "b-writer", "holds": ["ghost_b", "posts_tags"], "wants": ["ghost_b", "posts"]}],
        "timeout_on": ["ghost_c", "t1"],
        "lock": ["timeout", "timeout", "ok"],
    }

    def _dump(self):
        return dn.run_mysqldump(
            socket_path="/tmp/mysqld.sock", password="pw", out_path=self.out_path, limits=FAST, sleep=lambda s: None
        )

    def test_a_busy_tenant_never_makes_another_tenants_tables_be_locked_again(self):
        self.fakes.configure(**self.BUSY_C)
        self._dump()
        # One cross-schema statement is retried for every tenant whenever any
        # tenant is slow: tenant b's writer would be exposed three times
        # (a lock attempt per retry). One statement per schema exposes it once.
        self.assertEqual(len(self.fakes.victims("b-writer")), 1)

    def test_the_exposure_that_remains_is_the_tenants_own_single_attempt(self):
        # The change bounds the exposure, it does not remove it: tenant b's
        # own LOCK TABLES still takes b's tables in name order. Removing it
        # needs a snapshot that takes no table locks at all.
        self.fakes.configure(**{**self.BUSY_C, "timeout_on": None, "lock": ["ok"]})
        self._dump()
        self.assertEqual(len(self.fakes.victims("b-writer")), 1)

    def test_control_a_writer_taking_its_tables_in_name_order_is_never_a_victim(self):
        in_order = [{"name": "b-writer", "holds": ["ghost_b", "posts"], "wants": ["ghost_b", "posts_tags"]}]
        self.fakes.configure(**{**self.BUSY_C, "inflight": in_order})
        self._dump()
        self.assertEqual(self.fakes.victims(), [])

    def test_control_the_model_finds_the_victim_on_the_cross_schema_statement(self):
        # Proves the fake can see the failure at all: one statement over every
        # schema (the old shape) is a victim on each of its three attempts.
        self.fakes.configure(**self.BUSY_C)
        everything = bs.lock_tables_sql([tuple(pair) for pair in self.BUSY_C["tables"]])
        for _ in range(3):
            subprocess.run(
                ["mysql"], input=f"{everything}\n".encode(), capture_output=True, check=False
            )
        self.assertEqual(len(self.fakes.victims("b-writer")), 3)


class RunStatusTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.dir = os.path.join(tmp.name, "m")
        self.path = os.path.join(self.dir, dn.STATUS_FILENAME)

    def _text(self):
        with open(self.path, encoding="utf-8") as handle:
            return handle.read()

    def _assert_no_raise(self, **kwargs):
        try:
            dn.record_run_status(succeeded=True, now=1.0, **kwargs)
        except Exception as exc:  # the property under test is that nothing escapes
            self.fail(f"record_run_status raised {exc!r}")

    def test_a_success_publishes_the_status_and_the_time(self):
        dn.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000.4)
        text = self._text()
        self.assertIn("db_nightly_dump_last_run_success 1\n", text)
        self.assertIn("db_nightly_dump_last_success_timestamp_seconds 1790000000\n", text)

    def test_a_failure_keeps_the_previous_success_time(self):
        dn.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000)
        dn.record_run_status(metrics_dir=self.dir, succeeded=False, now=1_790_086_400)
        text = self._text()
        self.assertIn("db_nightly_dump_last_run_success 0\n", text)
        self.assertIn("db_nightly_dump_last_success_timestamp_seconds 1790000000\n", text)

    def test_a_failure_with_no_success_on_record_publishes_no_time(self):
        dn.record_run_status(metrics_dir=self.dir, succeeded=False, now=1_790_086_400)
        text = self._text()
        self.assertIn("db_nightly_dump_last_run_success 0\n", text)
        self.assertNotIn("last_success_timestamp_seconds", text)

    def test_a_corrupt_previous_file_is_treated_as_no_success(self):
        os.makedirs(self.dir)
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("db_nightly_dump_last_success_timestamp_seconds not-a-number\n\x00\x01")
        dn.record_run_status(metrics_dir=self.dir, succeeded=False, now=1_790_086_400)
        self.assertNotIn("last_success_timestamp_seconds", self._text())

    def test_no_metrics_dir_writes_nothing(self):
        for value in (None, ""):
            dn.record_run_status(metrics_dir=value, succeeded=True, now=1.0)
        self.assertFalse(os.path.exists(self.dir))

    def test_the_file_is_world_readable_and_leaves_no_temp_file(self):
        dn.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o644)
        self.assertEqual(os.listdir(self.dir), [dn.STATUS_FILENAME])

    def test_a_failed_replace_leaves_the_old_file_whole_and_no_temp_file(self):
        dn.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000)
        before = self._text()
        with mock.patch("dump_nightly.os.replace", side_effect=OSError("disk full")):
            dn.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_086_400)
        self.assertEqual(self._text(), before)
        self.assertEqual(os.listdir(self.dir), [dn.STATUS_FILENAME])

    def test_no_failure_to_write_ever_raises(self):
        blocker = os.path.join(self.tmp, "file")
        with open(blocker, "w", encoding="utf-8") as handle:
            handle.write("x")
        self._assert_no_raise(metrics_dir=blocker)
        with mock.patch("dump_nightly.tempfile.mkstemp", side_effect=RuntimeError("unexpected")):
            self._assert_no_raise(metrics_dir=self.dir)


class MainStatusTests(unittest.TestCase):
    ENV = {
        "DB_DUMP_MYSQL_PWD": "pw",
        "AGE_RECIPIENT_PUBLIC_KEY": "age1recipient",
        "DB_BACKUP_BUCKET": "b",
        "DB_BACKUP_ENDPOINT": "e",
        "DB_BACKUP_REGION": "r",
        "AWS_ACCESS_KEY_ID": "AK",
        "AWS_SECRET_ACCESS_KEY": "SECRET",
    }

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = os.path.join(tmp.name, "m")
        self.blocker = os.path.join(tmp.name, "file")
        with open(self.blocker, "w", encoding="utf-8") as handle:
            handle.write("x")
        patcher = mock.patch.dict(os.environ, {**self.ENV, "DB_DUMP_METRICS_DIR": self.dir})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _status(self):
        path = os.path.join(self.dir, dn.STATUS_FILENAME)
        self.assertTrue(os.path.exists(path), "no status file was written")
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def test_a_stored_dump_publishes_success(self):
        with mock.patch.object(dn, "run_dump", return_value="dumps/u/db1-x.sql.age"):
            self.assertEqual(dn.main([]), 0)
        text = self._status()
        self.assertIn("db_nightly_dump_last_run_success 1\n", text)
        self.assertIn("db_nightly_dump_last_success_timestamp_seconds ", text)

    def test_a_failed_dump_publishes_failure_and_still_exits_1(self):
        with mock.patch.object(dn, "run_dump", side_effect=dn.DumpError("boom")):
            self.assertEqual(dn.main([]), 1)
        self.assertIn("db_nightly_dump_last_run_success 0\n", self._status())

    def test_a_missing_setting_publishes_failure(self):
        del os.environ["DB_BACKUP_BUCKET"]
        self.assertEqual(dn.main([]), 1)
        self.assertIn("db_nightly_dump_last_run_success 0\n", self._status())

    def test_an_unexpected_error_publishes_failure_and_still_propagates(self):
        with mock.patch.object(dn, "run_dump", side_effect=RuntimeError("unexpected")):
            with self.assertRaises(RuntimeError):
                dn.main([])
        self.assertIn("db_nightly_dump_last_run_success 0\n", self._status())

    def test_the_status_is_written_only_after_the_dump_has_returned(self):
        order = []
        with mock.patch.object(dn, "run_dump", side_effect=lambda **kw: order.append("dump") or "k"), \
                mock.patch.object(dn, "record_run_status", side_effect=lambda **kw: order.append("status")):
            dn.main([])
        self.assertEqual(order, ["dump", "status"])

    def test_an_unwritable_metrics_dir_never_fails_the_dump(self):
        os.environ["DB_DUMP_METRICS_DIR"] = self.blocker
        with mock.patch.object(dn, "run_dump", return_value="dumps/u/db1-x.sql.age"):
            self.assertEqual(dn.main([]), 0)

    def test_a_broken_writer_never_fails_the_dump(self):
        with mock.patch.object(dn, "run_dump", return_value="k"), \
                mock.patch("dump_nightly.tempfile.mkstemp", side_effect=RuntimeError("unexpected")):
            try:
                code = dn.main([])
            except Exception as exc:  # the property under test is that nothing escapes
                self.fail(f"main raised {exc!r}")
        self.assertEqual(code, 0)


class RunDumpTests(_FakeClientsOnPath):
    def setUp(self):
        super().setUp()
        self.now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)
        self.uploads = []

    def _fake_upload(self, **kwargs):
        self.uploads.append(kwargs)

    def _run_dump(self, run, **overrides):
        kwargs = dict(
            socket_path="/tmp/mysqld.sock",
            password="pw",
            recipient="age1recipient",
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            now=self.now,
            run=run,
            upload=self._fake_upload,
            limits=FAST,
            sleep=lambda s: None,
        )
        kwargs.update(overrides)
        return dn.run_dump(**kwargs)

    def test_happy_path_uploads_the_encrypted_dump_under_the_uuid_namespaced_key(self):
        run = FakeRun()
        key = self._run_dump(run)
        self.assertEqual(key, f"dumps/{FAKE_SERVER_UUID}/db1-20260822T031500Z.sql.age")
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.uploads[0]["key"], key)
        self.assertEqual(
            self.uploads[0]["data"],
            b"AGE-ENCRYPTED:"
            + (
                b"-- BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000007', MASTER_LOG_POS=1234;\n"
                b"-- dump content\n"
            )
            * 2,
        )
        self.assertEqual(self.uploads[0]["bucket"], "branchleft-db-backups")

    def test_a_failed_server_uuid_lookup_never_reaches_mysqldump(self):
        run = FakeRun(fail_command="mysql")
        with self.assertRaises(dn.DumpError):
            self._run_dump(run)
        self.assertEqual(self.uploads, [])
        self.assertEqual(self.fakes.starts("mysqldump"), [])

    def test_a_failed_mysqldump_never_reaches_encrypt_or_upload(self):
        self.fakes.configure(dump_exit=2)
        run = FakeRun()
        with self.assertRaises(dn.DumpError):
            self._run_dump(run)
        self.assertEqual(self.uploads, [])
        self.assertNotIn("age", [c[0] for c in run.calls])

    def test_a_failed_encrypt_never_reaches_upload(self):
        run = FakeRun(fail_command="age")
        with self.assertRaises(dn.DumpError):
            self._run_dump(run)
        self.assertEqual(self.uploads, [])

    def test_the_tempdir_is_gone_once_run_dump_returns(self):
        seen_paths = []

        def spying_run(argv, **kwargs):
            if argv[0] == "age":
                seen_paths.append(os.path.dirname(argv[-1]))
            return FakeRun()(argv, **kwargs)

        self._run_dump(spying_run)
        self.assertEqual(len(seen_paths), 1)
        self.assertFalse(os.path.exists(seen_paths[0]))


class RequireEnvTests(unittest.TestCase):
    def test_raises_when_missing(self):
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOES_NOT_EXIST_XYZ", None)
            with self.assertRaises(dn.DumpError):
                dn._require_env("DOES_NOT_EXIST_XYZ")


if __name__ == "__main__":
    unittest.main()

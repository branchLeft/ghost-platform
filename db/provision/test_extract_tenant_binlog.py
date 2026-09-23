#!/usr/bin/env python3
"""Unit tests for extract_tenant_binlog.py.

The property worth the most coverage is the one the story exists for: a
scoped replay must carry exactly one tenant's post-resume events and none of
another's. FakeRun below plays the part of mysqlbinlog well enough to prove
that property in-process -- it holds a tiny fake event stream tagged by
database and filters it the way `--database=<name>` does -- rather than
proving only that this module's argv construction looks right. The real
`mysqlbinlog` binary is exercised separately, against a real MySQL instance
in Docker, per db/RUNBOOK-db.md's restore drill; that is not a unit test and
does not belong in this file's fast, hermetic run.
"""

from __future__ import annotations

import subprocess
import unittest

import extract_tenant_binlog as etb

DUMP_WITH_RESUME_POINT = """\
-- MySQL dump 10.13  Distrib 8.0.46
--
-- Host: localhost    Database: tenant_a
-- ------------------------------------------------------
--
-- Position to start replication or point-in-time recovery from
--

-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;

CREATE TABLE `posts` (...);
"""


class FakeMysqlbinlog:
    """A fake event stream tagged by database and position, filtered the
    way `mysqlbinlog --database=<name> --start-position=<n>` filters a real
    row-format binlog: events before start_position are dropped, and with a
    database given, only that database's events survive."""

    def __init__(self, events, *, fail=False):
        # events: list of (file, position, database, payload) in file order.
        self.events = events
        self.fail = fail
        self.calls = []

    def __call__(self, argv, capture_output=None, check=None, input=None, env=None):
        self.calls.append(list(argv))
        command = argv[0]

        if command == "mysqlbinlog":
            if self.fail:
                return subprocess.CompletedProcess(argv, 1, stdout=b"", stderr=b"boom")
            database = None
            start_position = 0
            stop_datetime = None
            files = []
            for arg in argv[1:]:
                if arg.startswith("--database="):
                    database = arg.split("=", 1)[1]
                elif arg.startswith("--start-position="):
                    start_position = int(arg.split("=", 1)[1])
                elif arg.startswith("--stop-datetime="):
                    stop_datetime = arg.split("=", 1)[1]
                else:
                    files.append(arg)
            out = []
            for file, position, db, payload in self.events:
                if file not in files:
                    continue
                if file == files[0] and position < start_position:
                    continue
                if database is not None and db != database:
                    continue
                if stop_datetime is not None and payload.startswith("STOP:"):
                    continue
                out.append(payload)
            return subprocess.CompletedProcess(argv, 0, stdout="\n".join(out).encode(), stderr=b"")

        if command == "mysql":
            if self.fail:
                return subprocess.CompletedProcess(argv, 1, stdout=b"", stderr=b"apply failed")
            self.applied = input
            return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

        raise AssertionError(f"unexpected command: {command}")


# One resume file plus a rotated second file, mirroring the design spike's
# own two-file replay (binlog.000003 -> binlog.000004).
SAMPLE_EVENTS = [
    ("mysql-bin.000003", 1000, "tenant_a", "USE tenant_a; -- before resume, must never appear"),
    ("mysql-bin.000003", 2000, "tenant_a", "USE tenant_a; INSERT INTO posts VALUES ('A post-resume')"),
    ("mysql-bin.000003", 2100, "tenant_b", "USE tenant_b; INSERT INTO posts VALUES ('B post-resume')"),
    ("mysql-bin.000004", 500, "tenant_a", "USE tenant_a; INSERT INTO posts VALUES ('A second post')"),
    ("mysql-bin.000004", 600, "tenant_b", "USE tenant_b; INSERT INTO posts VALUES ('B second post')"),
]


class ParseDumpResumePointTests(unittest.TestCase):
    def test_reads_log_file_and_position(self):
        self.assertEqual(etb.parse_dump_resume_point(DUMP_WITH_RESUME_POINT), ("mysql-bin.000003", 1653))

    def test_raises_when_the_comment_is_absent(self):
        with self.assertRaises(etb.ExtractError):
            etb.parse_dump_resume_point("-- MySQL dump 10.13\nCREATE TABLE foo (...);\n")

    def test_raises_on_an_uncommented_change_master(self):
        # --source-data=1's form: not what this dump is required to carry,
        # and matching it would let an unscoped resume point through silently.
        text = "CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;\n"
        with self.assertRaises(etb.ExtractError):
            etb.parse_dump_resume_point(text)

    def test_tolerates_surrounding_dump_content(self):
        text = "-- some header\n\n" + DUMP_WITH_RESUME_POINT + "\nINSERT INTO x VALUES (1);\n"
        self.assertEqual(etb.parse_dump_resume_point(text), ("mysql-bin.000003", 1653))


class MysqlbinlogArgvTests(unittest.TestCase):
    def test_scoped_argv_carries_the_database_filter(self):
        argv = etb.mysqlbinlog_argv(["mysql-bin.000003"], database="tenant_a", start_position=1653)
        self.assertEqual(
            argv,
            ["mysqlbinlog", "--start-position=1653", "--database=tenant_a", "mysql-bin.000003"],
        )

    def test_unscoped_argv_omits_the_filter(self):
        # The control-case shape: identical otherwise, so a sabotage of the
        # filter is "drop this one flag", never a second code path to rot.
        argv = etb.mysqlbinlog_argv(["mysql-bin.000003"], database=None, start_position=1653)
        self.assertNotIn("--database=tenant_a", argv)
        self.assertEqual(argv, ["mysqlbinlog", "--start-position=1653", "mysql-bin.000003"])

    def test_stop_datetime_is_optional(self):
        argv = etb.mysqlbinlog_argv(["f"], database="tenant_a", start_position=1, stop_datetime="2026-09-23 14:00:00")
        self.assertIn("--stop-datetime=2026-09-23 14:00:00", argv)

    def test_multiple_files_in_order(self):
        argv = etb.mysqlbinlog_argv(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653
        )
        self.assertEqual(argv[-2:], ["mysql-bin.000003", "mysql-bin.000004"])

    def test_raises_with_no_files(self):
        with self.assertRaises(etb.ExtractError):
            etb.mysqlbinlog_argv([], database="tenant_a", start_position=1)


class ExtractTenantStreamTests(unittest.TestCase):
    def test_scoped_extract_carries_only_the_named_tenants_post_resume_events(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        ).decode()
        self.assertIn("A post-resume", out)
        self.assertIn("A second post", out)
        self.assertNotIn("before resume", out)
        self.assertNotIn("tenant_b", out)
        self.assertNotIn("B post-resume", out)
        self.assertNotIn("B second post", out)

    def test_unscoped_extract_carries_the_other_tenants_events_too(self):
        # The control case (R3-style): with no --database filter, the other
        # tenant's writes are present in the very same stream -- proving the
        # scoped test above could have failed, rather than passing vacuously.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database=None, start_position=1653, run=run
        ).decode()
        self.assertIn("B post-resume", out)
        self.assertIn("B second post", out)

    def test_raises_on_nonzero_exit(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS, fail=True)
        with self.assertRaises(etb.ExtractError):
            etb.extract_tenant_stream(["mysql-bin.000003"], database="tenant_a", start_position=1653, run=run)


class ApplyStreamTests(unittest.TestCase):
    def test_uses_socket_when_given(self):
        run = FakeMysqlbinlog([])
        etb.apply_stream(b"SQL", socket_path="/tmp/mysqld.sock", user="root", password="pw", run=run)
        call = run.calls[0]
        self.assertIn("--socket", call)
        self.assertNotIn("--host", call)

    def test_uses_host_when_given(self):
        run = FakeMysqlbinlog([])
        etb.apply_stream(b"SQL", host="restore-target", user="root", password="pw", run=run)
        call = run.calls[0]
        self.assertIn("--host", call)
        self.assertNotIn("--socket", call)

    def test_raises_when_both_or_neither_target_given(self):
        run = FakeMysqlbinlog([])
        with self.assertRaises(etb.ExtractError):
            etb.apply_stream(b"SQL", user="root", password="pw", run=run)
        with self.assertRaises(etb.ExtractError):
            etb.apply_stream(
                b"SQL", socket_path="/tmp/s", host="h", user="root", password="pw", run=run
            )

    def test_raises_on_nonzero_exit(self):
        run = FakeMysqlbinlog([], fail=True)
        with self.assertRaises(etb.ExtractError):
            etb.apply_stream(b"SQL", socket_path="/tmp/mysqld.sock", user="root", password="pw", run=run)


class RestorePointInTimeTests(unittest.TestCase):
    def test_end_to_end_applies_only_the_named_tenants_stream(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        sql = etb.restore_point_in_time(
            dump_text=DUMP_WITH_RESUME_POINT,
            binlog_paths=["mysql-bin.000003", "mysql-bin.000004"],
            tenant_database="tenant_a",
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertIn(b"A post-resume", sql)
        self.assertNotIn(b"tenant_b", sql)
        self.assertEqual(run.applied, sql)

    def test_files_before_the_resume_file_are_excluded(self):
        # A binlog rotated before the dump's own resume point is entirely
        # pre-dump for every tenant; including it would only risk re-applying
        # an event the dump itself already captured.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        etb.restore_point_in_time(
            dump_text=DUMP_WITH_RESUME_POINT,
            binlog_paths=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003", "mysql-bin.000004"],
            tenant_database="tenant_a",
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        mysqlbinlog_call = next(c for c in run.calls if c[0] == "mysqlbinlog")
        self.assertNotIn("mysql-bin.000001", mysqlbinlog_call)
        self.assertNotIn("mysql-bin.000002", mysqlbinlog_call)

    def test_raises_when_the_resume_file_is_not_among_the_given_binlogs(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        with self.assertRaises(etb.ExtractError):
            etb.restore_point_in_time(
                dump_text=DUMP_WITH_RESUME_POINT,
                binlog_paths=["mysql-bin.000005"],
                tenant_database="tenant_a",
                apply_socket_path="/tmp/mysqld.sock",
                apply_user="root",
                apply_password="pw",
                run=run,
            )


class MainTests(unittest.TestCase):
    def test_fails_without_the_password_env_var(self):
        import io
        import os

        os.environ.pop("MYSQL_PWD", None)
        stderr = io.StringIO()
        import contextlib

        with contextlib.redirect_stderr(stderr):
            rc = etb.main(
                [
                    "--dump",
                    "/nonexistent/dump.sql",
                    "--tenant-database",
                    "tenant_a",
                    "--apply-socket",
                    "/tmp/mysqld.sock",
                    "--apply-user",
                    "root",
                    "mysql-bin.000003",
                ]
            )
        self.assertEqual(rc, 1)
        self.assertIn("MYSQL_PWD", stderr.getvalue())

    def test_fails_when_the_dump_file_is_missing(self):
        import os

        os.environ["MYSQL_PWD"] = "pw"
        try:
            rc = etb.main(
                [
                    "--dump",
                    "/nonexistent/dump.sql",
                    "--tenant-database",
                    "tenant_a",
                    "--apply-socket",
                    "/tmp/mysqld.sock",
                    "--apply-user",
                    "root",
                    "mysql-bin.000003",
                ]
            )
        finally:
            del os.environ["MYSQL_PWD"]
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Unit tests for extract_tenant_binlog.py.

The property worth the most coverage is the one the story exists for: a
scoped replay must carry exactly one tenant's post-resume events and none of
another's -- filtered on the *table* a row event targets, never on which
database a session had `USE`d, which is what makes AX/BX in SAMPLE_EVENTS
below load-bearing rather than decorative. A close second is that a
legitimately empty replay (a quiet tenant, or a `--stop-datetime` chosen
before a tenant's first post-dump write) is a *success*, not a typo --
only a genuine mismatch against the dump's own declared databases is.
FakeMysqlbinlog plays the part of mysqlbinlog well enough to prove both
properties in-process, including its Table_map annotation, rather than
proving only that this module's argv construction looks right. The real
`mysqlbinlog` binary is exercised separately, against a real MySQL instance
in Docker, per db/RUNBOOK-db.md's restore drill; that is not a unit test
and does not belong in this file's fast, hermetic run.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest

import extract_tenant_binlog as etb

# tenant_a, tenant_b: the two tenants SAMPLE_EVENTS carries writes for.
# tenant_quiet: declared in the dump, but appears in no event anywhere --
# a tenant that has written nothing since the dump.
# tenant_early: declared in the dump; its only event is tagged so a
# --stop-datetime excludes it (see FakeMysqlbinlog) -- a tenant whose first
# post-dump write is after the chosen restore instant.
DUMP_WITH_RESUME_POINT = """\
-- MySQL dump 10.13  Distrib 8.0.46
--
-- Host: localhost    Database: tenant_a
-- ------------------------------------------------------
--
-- Position to start replication or point-in-time recovery from
--

-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_a` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `tenant_a`;

CREATE TABLE `posts` (...);

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_b` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `tenant_b`;

CREATE TABLE `posts` (...);

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_quiet` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `tenant_quiet`;

CREATE TABLE `posts` (...);

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_early` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `tenant_early`;

CREATE TABLE `posts` (...);
"""


class FakeMysqlbinlog:
    """A fake event stream tagged by the row event's own *table* database
    (never the session's `USE`), filtered the way a real
    `mysqlbinlog --database=<name> --start-position=<n> [--stop-datetime=<t>]`
    filters a real row-format binlog. Each kept event's fake output line
    carries a `Table_map: \\`<table_database>\\`.\\`posts\\`` annotation, the
    same shape tenant_wrote_anything looks for in real output. A marker
    starting `STOP-EXCLUDED` is dropped whenever *any* stop_datetime is
    given -- this fake does not model specific instants, only "before" vs
    "after" a stop, which is all the tests below need."""

    def __init__(self, events, *, fail=False):
        # events: list of (file, position, table_database, marker) in file order.
        self.events = events
        self.fail = fail
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []
        self.applied = None

    def __call__(self, argv, capture_output=None, check=None, input=None, env=None):
        self.calls.append(list(argv))
        self.envs.append(env)
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
            for file, position, table_database, marker in self.events:
                if file not in files:
                    continue
                if file == files[0] and position < start_position:
                    continue
                if database is not None and table_database != database:
                    continue
                if stop_datetime is not None and marker.startswith("STOP-EXCLUDED"):
                    continue
                out.append(f"Table_map: `{table_database}`.`posts`\n{marker}")
            return subprocess.CompletedProcess(argv, 0, stdout="\n".join(out).encode(), stderr=b"")

        if command == "mysql":
            if self.fail:
                return subprocess.CompletedProcess(argv, 1, stdout=b"", stderr=b"apply failed")
            self.applied = input
            return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

        raise AssertionError(f"unexpected command: {command}")


# Three files across the resume file and two rotations (000003 -> 000004 ->
# 000005), mirroring the design spike's own multi-file replay. AX/BX are
# cross-session writes: AX's row event targets tenant_a even though its
# (fake) session had USEd tenant_b, and BX is the mirror image -- proving
# the filter follows the table, not the session. tenant_early's only event
# is STOP-EXCLUDED: with any --stop-datetime, it vanishes, modelling a
# restore instant chosen before that tenant's first post-dump write.
# tenant_quiet has no event at all, anywhere.
SAMPLE_EVENTS = [
    ("mysql-bin.000003", 1000, "tenant_a", "A0-before-resume-must-never-appear"),
    ("mysql-bin.000003", 2000, "tenant_a", "A1-post-resume"),
    ("mysql-bin.000003", 2100, "tenant_b", "B1-post-resume"),
    ("mysql-bin.000003", 2200, "tenant_a", "AX-write-to-tenant_a-from-a-tenant_b-session"),
    ("mysql-bin.000003", 2300, "tenant_early", "STOP-EXCLUDED-tenant_early-first-write"),
    ("mysql-bin.000004", 500, "tenant_a", "A2-second-file"),
    ("mysql-bin.000004", 600, "tenant_b", "B2-second-file"),
    ("mysql-bin.000004", 700, "tenant_b", "BX-write-to-tenant_b-from-a-tenant_a-session"),
    ("mysql-bin.000005", 100, "tenant_a", "A3-third-file"),
]


class FindResumePointTests(unittest.TestCase):
    def test_reads_log_file_and_position(self):
        self.assertEqual(
            etb.parse_dump_resume_point(DUMP_WITH_RESUME_POINT, tenant_database="tenant_a"),
            ("mysql-bin.000003", 1653),
        )

    def test_raises_when_the_comment_is_absent(self):
        with self.assertRaises(etb.ExtractError):
            etb.parse_dump_resume_point(
                "-- MySQL dump 10.13\nCREATE DATABASE `tenant_a`;\n", tenant_database="tenant_a"
            )

    def test_raises_on_an_uncommented_change_master(self):
        # --source-data=1's form: not what this dump is required to carry,
        # and matching it would let an unscoped resume point through silently.
        text = "CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;\nCREATE DATABASE `tenant_a`;\n"
        with self.assertRaises(etb.ExtractError):
            etb.parse_dump_resume_point(text, tenant_database="tenant_a")

    def test_tolerates_surrounding_dump_content(self):
        text = "-- some header\n\n" + DUMP_WITH_RESUME_POINT + "\nINSERT INTO x VALUES (1);\n"
        self.assertEqual(
            etb.parse_dump_resume_point(text, tenant_database="tenant_a"), ("mysql-bin.000003", 1653)
        )

    def test_raises_when_the_tenant_database_is_not_in_the_dump(self):
        # The typo case: a --tenant-database that matches no database this
        # dump actually declares. This is the ONLY guard that catches a
        # typo -- a quiet tenant or an early stop-datetime must not trip it.
        with self.assertRaises(etb.ExtractError) as ctx:
            etb.parse_dump_resume_point(DUMP_WITH_RESUME_POINT, tenant_database="tenant_c")
        self.assertIn("tenant_c", str(ctx.exception))

    def test_accepts_a_tenant_declared_only_via_USE(self):
        text = (
            "-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000001', MASTER_LOG_POS=4;\n"
            "USE `only_use_declared`;\n"
        )
        self.assertEqual(
            etb.parse_dump_resume_point(text, tenant_database="only_use_declared"),
            ("mysql-bin.000001", 4),
        )

    def test_read_dump_resume_point_streams_a_real_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        try:
            self.assertEqual(
                etb.read_dump_resume_point(path, tenant_database="tenant_b"), ("mysql-bin.000003", 1653)
            )
        finally:
            os.unlink(path)


class AssertContiguousTests(unittest.TestCase):
    def test_single_file_is_always_fine(self):
        etb.assert_contiguous(["mysql-bin.000003"])  # must not raise

    def test_consecutive_files_are_fine(self):
        etb.assert_contiguous(["mysql-bin.000003", "mysql-bin.000004", "mysql-bin.000005"])

    def test_raises_on_a_gap(self):
        with self.assertRaises(etb.ExtractError) as ctx:
            etb.assert_contiguous(["mysql-bin.000003", "mysql-bin.000005"])
        self.assertIn("gap", str(ctx.exception))

    def test_raises_on_a_mismatched_base_name(self):
        with self.assertRaises(etb.ExtractError):
            etb.assert_contiguous(["mysql-bin.000003", "other-bin.000004"])

    def test_raises_on_a_non_binlog_filename(self):
        with self.assertRaises(etb.ExtractError):
            etb.assert_contiguous(["mysql-bin.000003", "not-a-binlog-name"])

    def test_tolerates_a_directory_prefix(self):
        etb.assert_contiguous(["/data/mysql-bin.000003", "/data/mysql-bin.000004"])


class SortedBinlogPathsTests(unittest.TestCase):
    def test_sorts_by_sequence_number_regardless_of_input_order(self):
        self.assertEqual(
            etb.sorted_binlog_paths(["mysql-bin.000005", "mysql-bin.000003", "mysql-bin.000004"]),
            ["mysql-bin.000003", "mysql-bin.000004", "mysql-bin.000005"],
        )

    def test_already_sorted_is_unchanged(self):
        paths = ["mysql-bin.000003", "mysql-bin.000004"]
        self.assertEqual(etb.sorted_binlog_paths(paths), paths)

    def test_raises_on_an_unparseable_filename(self):
        with self.assertRaises(etb.ExtractError):
            etb.sorted_binlog_paths(["mysql-bin.000003", "not-a-binlog-name"])


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


class TenantWroteAnythingTests(unittest.TestCase):
    def test_true_when_the_tenants_table_map_is_present(self):
        sql = b"Table_map: `tenant_a`.`posts`\nsome row event"
        self.assertTrue(etb.tenant_wrote_anything(sql, "tenant_a"))

    def test_false_when_absent(self):
        sql = b"Table_map: `tenant_b`.`posts`\nsome row event"
        self.assertFalse(etb.tenant_wrote_anything(sql, "tenant_a"))

    def test_false_on_empty_stream(self):
        self.assertFalse(etb.tenant_wrote_anything(b"", "tenant_a"))

    def test_never_raises(self):
        # Unlike find_resume_point's declaration check, this is purely
        # descriptive -- it is not this function's job to decide whether an
        # empty result is a typo or a legitimately quiet tenant.
        self.assertFalse(etb.tenant_wrote_anything(b"nothing relevant here", "tenant_a"))


class ExtractTenantStreamTests(unittest.TestCase):
    def test_scoped_extract_carries_only_the_named_tenants_post_resume_events(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        ).decode()
        self.assertIn("A1-post-resume", out)
        self.assertIn("A2-second-file", out)
        self.assertNotIn("A0-before-resume", out)
        self.assertNotIn("B1-post-resume", out)
        self.assertNotIn("B2-second-file", out)

    def test_scoped_extract_keeps_a_cross_session_write_to_the_named_tenant(self):
        # AX's row event targets tenant_a even though its session had USEd
        # tenant_b -- proving the filter is table-based, not USE-based.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        ).decode()
        self.assertIn("AX-write-to-tenant_a-from-a-tenant_b-session", out)

    def test_scoped_extract_excludes_a_cross_session_write_to_the_other_tenant(self):
        # BX's row event targets tenant_b even though its session had USEd
        # tenant_a -- the mirror image of AX, and must stay excluded.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        ).decode()
        self.assertNotIn("BX-write-to-tenant_b-from-a-tenant_a-session", out)

    def test_unscoped_extract_carries_the_other_tenants_events_too(self):
        # The control case (R3-style): with no --database filter, the other
        # tenant's writes are present in the very same stream -- proving the
        # scoped tests above could have failed, rather than passing vacuously.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database=None, start_position=1653, run=run
        ).decode()
        self.assertIn("B1-post-resume", out)
        self.assertIn("B2-second-file", out)

    def test_raises_on_nonzero_exit(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS, fail=True)
        with self.assertRaises(etb.ExtractError):
            etb.extract_tenant_stream(["mysql-bin.000003"], database="tenant_a", start_position=1653, run=run)

    def test_returns_empty_scoped_result_without_raising_for_a_quiet_tenant(self):
        # extract_tenant_stream itself never decides whether an empty
        # result is a problem -- that is _replay_from_resume_point's job
        # (via tenant_wrote_anything). A tenant with zero events in range
        # must not raise here.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        out = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_quiet", start_position=1653, run=run
        )
        self.assertFalse(etb.tenant_wrote_anything(out, "tenant_quiet"))

    def test_unscoped_extract_never_triggers_the_no_op_check(self):
        # database=None means "every tenant" -- there is no single tenant
        # to check tenant_wrote_anything against, and this function does
        # not perform that check itself in any case.
        run = FakeMysqlbinlog([])
        out = etb.extract_tenant_stream(["mysql-bin.000003"], database=None, start_position=0, run=run)
        self.assertEqual(out, b"")

    def test_env_passed_to_mysqlbinlog_is_path_and_tz_utc_only(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        )
        env = run.envs[0]
        self.assertEqual(env.get("TZ"), "UTC")
        self.assertIn("PATH", env)
        self.assertEqual(set(env.keys()), {"PATH", "TZ"})


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

    def test_env_passed_to_mysql_is_path_and_mysql_pwd_only(self):
        run = FakeMysqlbinlog([])
        etb.apply_stream(b"SQL", socket_path="/tmp/mysqld.sock", user="root", password="pw", run=run)
        env = run.envs[0]
        self.assertEqual(env.get("MYSQL_PWD"), "pw")
        self.assertIn("PATH", env)
        self.assertEqual(set(env.keys()), {"PATH", "MYSQL_PWD"})
        self.assertNotIn("TZ", env)


class RestorePointInTimeTests(unittest.TestCase):
    def test_end_to_end_applies_only_the_named_tenants_stream(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        result = etb.restore_point_in_time(
            dump_text=DUMP_WITH_RESUME_POINT,
            binlog_paths=["mysql-bin.000003", "mysql-bin.000004"],
            tenant_database="tenant_a",
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertTrue(result.applied)
        self.assertIn(b"A1-post-resume", result.sql)
        self.assertNotIn(b"B1-post-resume", result.sql)
        self.assertEqual(run.applied, result.sql)

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

    def test_raises_when_the_tenant_is_not_in_the_dump(self):
        # The genuine typo case -- still refused, and still the ONLY case
        # that is.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        with self.assertRaises(etb.ExtractError):
            etb.restore_point_in_time(
                dump_text=DUMP_WITH_RESUME_POINT,
                binlog_paths=["mysql-bin.000003"],
                tenant_database="tenant_c",
                apply_socket_path="/tmp/mysqld.sock",
                apply_user="root",
                apply_password="pw",
                run=run,
            )

    def test_raises_on_a_binlog_gap_after_the_resume_file(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        with self.assertRaises(etb.ExtractError) as ctx:
            etb.restore_point_in_time(
                dump_text=DUMP_WITH_RESUME_POINT,
                binlog_paths=["mysql-bin.000003", "mysql-bin.000005"],
                tenant_database="tenant_a",
                apply_socket_path="/tmp/mysqld.sock",
                apply_user="root",
                apply_password="pw",
                run=run,
            )
        self.assertIn("gap", str(ctx.exception))

    # -- Round-2 finding 1: a quiet tenant, or a --stop-datetime before a
    # tenant's first post-dump write, applies nothing and does not raise.

    def test_a_quiet_tenant_is_a_successful_empty_replay(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        result = etb.restore_point_in_time(
            dump_text=DUMP_WITH_RESUME_POINT,
            binlog_paths=["mysql-bin.000003", "mysql-bin.000004"],
            tenant_database="tenant_quiet",
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertFalse(result.applied)
        # apply_stream (the "mysql" command) must never have been called --
        # nothing to apply means nothing sent to the restore target.
        self.assertNotIn("mysql", [c[0] for c in run.calls])

    def test_a_stop_datetime_before_the_tenants_first_write_is_a_successful_empty_replay(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        result = etb.restore_point_in_time(
            dump_text=DUMP_WITH_RESUME_POINT,
            binlog_paths=["mysql-bin.000003"],
            tenant_database="tenant_early",
            stop_datetime="2026-09-23 00:00:00",  # any value: FakeMysqlbinlog only checks "given or not"
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertFalse(result.applied)
        self.assertNotIn("mysql", [c[0] for c in run.calls])

    # -- Round-2 finding 2: sort before slicing, check contiguity over the
    # whole given list.

    def test_unsorted_two_file_list_no_longer_drops_the_later_file(self):
        # Before the fix: binlog_paths[resume_index:] on an UNSORTED list
        # with resume file 000004 at index 0 would slice to ["000004"]
        # only, silently dropping 000005 -- exactly the round-2 finding.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        result = etb._replay_from_resume_point(
            log_file="mysql-bin.000004",
            position=0,
            binlog_paths=["mysql-bin.000005", "mysql-bin.000004"],
            tenant_database="tenant_a",
            stop_datetime=None,
            apply_socket_path="/tmp/mysqld.sock",
            apply_host=None,
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertIn(b"A2-second-file", result.sql)
        self.assertIn(b"A3-third-file", result.sql)
        mysqlbinlog_call = next(c for c in run.calls if c[0] == "mysqlbinlog")
        self.assertIn("mysql-bin.000004", mysqlbinlog_call)
        self.assertIn("mysql-bin.000005", mysqlbinlog_call)

    def test_unsorted_three_file_list_replays_correctly(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        result = etb._replay_from_resume_point(
            log_file="mysql-bin.000003",
            position=1653,
            binlog_paths=["mysql-bin.000003", "mysql-bin.000005", "mysql-bin.000004"],
            tenant_database="tenant_a",
            stop_datetime=None,
            apply_socket_path="/tmp/mysqld.sock",
            apply_host=None,
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertIn(b"A1-post-resume", result.sql)
        self.assertIn(b"A2-second-file", result.sql)
        self.assertIn(b"A3-third-file", result.sql)
        self.assertNotIn(b"B1-post-resume", result.sql)

    def test_unsorted_list_with_a_real_gap_still_refuses(self):
        # Sorting must not paper over a genuine gap -- ["000005", "000003"]
        # sorts to ["000003", "000005"], still missing 000004.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        with self.assertRaises(etb.ExtractError) as ctx:
            etb._replay_from_resume_point(
                log_file="mysql-bin.000003",
                position=1653,
                binlog_paths=["mysql-bin.000005", "mysql-bin.000003"],
                tenant_database="tenant_a",
                stop_datetime=None,
                apply_socket_path="/tmp/mysqld.sock",
                apply_host=None,
                apply_user="root",
                apply_password="pw",
                run=run,
            )
        self.assertIn("gap", str(ctx.exception))


class MainTests(unittest.TestCase):
    def test_fails_without_the_password_env_var(self):
        import contextlib
        import io

        os.environ.pop("MYSQL_PWD", None)
        stderr = io.StringIO()
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

    def test_fails_on_a_tenant_typo_without_calling_mysqlbinlog(self):
        os.environ["MYSQL_PWD"] = "pw"
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        try:
            rc = etb.main(
                [
                    "--dump",
                    path,
                    "--tenant-database",
                    "tennant_a",  # typo
                    "--apply-socket",
                    "/tmp/mysqld.sock",
                    "--apply-user",
                    "root",
                    "mysql-bin.000003",
                ]
            )
        finally:
            del os.environ["MYSQL_PWD"]
            os.unlink(path)
        self.assertEqual(rc, 1)

    def test_a_quiet_tenant_exits_zero_and_names_the_dump_as_the_restore(self):
        import contextlib
        import io

        os.environ["MYSQL_PWD"] = "pw"
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        try:
            # main() always uses subprocess.run internally, so this drives
            # the CLI path with a real (harmless) mysqlbinlog/mysql absent
            # from PATH would fail differently -- instead we call through
            # _replay_from_resume_point's own FakeMysqlbinlog path by
            # monkeypatching subprocess.run for the duration of the call.
            import unittest.mock as mock

            with mock.patch("extract_tenant_binlog.subprocess.run", FakeMysqlbinlog(SAMPLE_EVENTS)):
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    rc = etb.main(
                        [
                            "--dump",
                            path,
                            "--tenant-database",
                            "tenant_quiet",
                            "--apply-socket",
                            "/tmp/mysqld.sock",
                            "--apply-user",
                            "root",
                            "mysql-bin.000003",
                            "mysql-bin.000004",
                        ]
                    )
        finally:
            del os.environ["MYSQL_PWD"]
            os.unlink(path)
        self.assertEqual(rc, 0)
        self.assertIn(
            "no tenant_quiet events between the resume point and end; the loaded dump is the restore",
            stdout.getvalue(),
        )

    def test_a_stop_datetime_before_first_write_exits_zero_with_the_stop_named(self):
        import contextlib
        import io
        import unittest.mock as mock

        os.environ["MYSQL_PWD"] = "pw"
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        try:
            with mock.patch("extract_tenant_binlog.subprocess.run", FakeMysqlbinlog(SAMPLE_EVENTS)):
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    rc = etb.main(
                        [
                            "--dump",
                            path,
                            "--tenant-database",
                            "tenant_early",
                            "--stop-datetime",
                            "2026-09-23 00:00:00",
                            "--apply-socket",
                            "/tmp/mysqld.sock",
                            "--apply-user",
                            "root",
                            "mysql-bin.000003",
                        ]
                    )
        finally:
            del os.environ["MYSQL_PWD"]
            os.unlink(path)
        self.assertEqual(rc, 0)
        self.assertIn(
            "no tenant_early events between the resume point and 2026-09-23 00:00:00; the loaded dump is the restore",
            stdout.getvalue(),
        )


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Unit tests for extract_tenant_binlog.py.

The property worth the most coverage is the one the story exists for: a
scoped replay must carry exactly one tenant's post-resume events and none of
another's -- filtered on the *table* a row event targets, never on which
database a session had `USE`d, which is what makes AX/BX in SAMPLE_EVENTS
below load-bearing rather than decorative. Two more matter just as much: a
legitimately empty replay (a quiet tenant, or a `--stop-datetime` chosen
before a tenant's first post-dump write) is a *success*, not a typo -- only
a genuine mismatch against the dump's own declared databases is; and a
tenant whose only post-dump events are schema changes (DDL, logged as
`Query` events, never a `Table_map`/row event) must still be detected and
reported, not read as "wrote nothing". FakeMysqlbinlog plays the part of
mysqlbinlog well enough to prove all three in-process -- including its
`Table_map` and `Query`/`Rotate` event-header shapes -- rather than proving
only that this module's argv construction looks right. The real
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

# tenant_a, tenant_b: the two tenants SAMPLE_EVENTS carries row-event
# writes for. tenant_quiet: declared in the dump, but appears in no event
# anywhere -- a tenant that has written nothing since the dump.
# tenant_early: declared in the dump; its only event is tagged so a
# --stop-datetime excludes it (see FakeMysqlbinlog) -- a tenant whose first
# post-dump write is after the chosen restore instant. tenant_ddl:
# declared in the dump; its only post-dump events are DDL (Query events,
# never a Table_map).
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

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_ddl` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `tenant_ddl`;

CREATE TABLE `posts` (...);
"""


class FakeMysqlbinlog:
    """A fake event stream, filtered the way a real
    `mysqlbinlog --database=<name> --start-position=<n> [--stop-datetime=<t>]`
    filters a real row-format binlog. Each `events` entry is
    `(file, position, table_database, marker)`, where `marker` is one of:

    - `"ROW:<label>"` -- a row event (Table_map + label), filtered on
      `table_database` the way a real row event is: the table it targets,
      never a session's `USE`.
    - `"DDL:<statement>"` / `"BEGIN"` -- a Query event, filtered on
      `table_database` the way a real Query event is: the session's `USE`d
      database, mysqlbinlog's older, coarser rule (see the module
      docstring) -- modelled here by the same `table_database` field, since
      the fixture's "session" is exactly the `table_database` given.
    - `"ROTATE:<yymmdd>:<hh:mm:ss>"` -- a Rotate event, never filtered by
      `--database` or `--start-position`, same as the real thing.

    Every emitted event line begins with a `#`-prefixed header comment,
    matching real mysqlbinlog output closely enough that
    extract_tenant_binlog's own header-scanning regexes
    (QUERY_EVENT_HEADER_PATTERN, ROTATE_EVENT_PATTERN) work against it
    unmodified. A label/statement starting `STOP-EXCLUDED` is dropped
    whenever *any* stop_datetime is given -- this fake does not model
    specific instants, only "before" vs "after" a stop."""

    _QUERY_HEADER = (
        "#000000 00:00:00 server id 1  end_log_pos 1 CRC32 0x00000000 \tQuery\tthread_id=1"
        "\texec_time=0\terror_code=0"
    )

    def __init__(self, events, *, fail=False):
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
                kind, _, rest = marker.partition(":")

                if kind == "ROTATE":
                    yymmdd, _, hhmmss = rest.partition(":")
                    out.append(
                        f"#{yymmdd} {hhmmss} server id 1  end_log_pos 999 CRC32 0x00000000 "
                        f"\tRotate to next-file.000000  pos: 4"
                    )
                    continue

                if file == files[0] and position < start_position:
                    continue
                if database is not None and table_database != database:
                    continue
                if stop_datetime is not None and rest.startswith("STOP-EXCLUDED"):
                    continue

                if kind == "ROW":
                    out.append(
                        f"#000000 00:00:00 server id 1  end_log_pos 1 CRC32 0x00000000 "
                        f"\tTable_map: `{table_database}`.`posts` mapped to number 1\n{rest}"
                    )
                elif kind == "BEGIN":
                    out.append(f"{self._QUERY_HEADER}\nSET TIMESTAMP=1/*!*/;\nBEGIN\n/*!*/;")
                elif kind == "DDL":
                    out.append(f"{self._QUERY_HEADER}\nSET TIMESTAMP=1/*!*/;\n{rest}\n/*!*/;")
                else:
                    raise AssertionError(f"unknown fake event kind: {kind!r}")
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
# tenant_quiet has no event at all, anywhere. tenant_ddl's only events are
# DDL (Query events) plus the BEGIN/COMMIT bookkeeping around ordinary row
# writes elsewhere in the same file -- proving DDL is counted and BEGIN
# is not.
SAMPLE_EVENTS = [
    ("mysql-bin.000003", 1000, "tenant_a", "ROW:A0-before-resume-must-never-appear"),
    ("mysql-bin.000003", 1900, "tenant_a", "BEGIN"),
    ("mysql-bin.000003", 2000, "tenant_a", "ROW:A1-post-resume"),
    ("mysql-bin.000003", 2050, "tenant_b", "BEGIN"),
    ("mysql-bin.000003", 2100, "tenant_b", "ROW:B1-post-resume"),
    ("mysql-bin.000003", 2200, "tenant_a", "ROW:AX-write-to-tenant_a-from-a-tenant_b-session"),
    ("mysql-bin.000003", 2300, "tenant_early", "ROW:STOP-EXCLUDED-tenant_early-first-write"),
    ("mysql-bin.000003", 2400, "tenant_ddl", "BEGIN"),
    ("mysql-bin.000003", 2450, "tenant_ddl", "DDL:ALTER TABLE posts ADD COLUMN body TEXT"),
    ("mysql-bin.000003", 2500, "tenant_ddl", "DDL:CREATE TABLE tags (id INT PRIMARY KEY)"),
    ("mysql-bin.000003", 2550, "tenant_ddl", "DDL:DROP TABLE tags"),
    ("mysql-bin.000004", 500, "tenant_a", "ROW:A2-second-file"),
    ("mysql-bin.000004", 600, "tenant_b", "ROW:B2-second-file"),
    ("mysql-bin.000004", 700, "tenant_b", "ROW:BX-write-to-tenant_b-from-a-tenant_a-session"),
    ("mysql-bin.000004", 800, None, "ROTATE:260923:12:00:00"),
    ("mysql-bin.000005", 100, "tenant_a", "ROW:A3-third-file"),
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
        # typo -- a quiet tenant, an early stop-datetime, or a DDL-only
        # tenant must not trip it.
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


class CountTenantEventsTests(unittest.TestCase):
    def test_counts_row_events_and_excludes_begin(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        sql = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        )
        row_events, statements = etb.count_tenant_events(sql, "tenant_a")
        # A1, AX, A2 -- three row events for tenant_a in this range (A0 is
        # before the resume position and excluded by start_position).
        self.assertEqual(row_events, 3)
        # The BEGIN preceding A1 must not be counted as a statement.
        self.assertEqual(statements, 0)

    def test_counts_ddl_statements_and_excludes_their_begin(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        sql = etb.extract_tenant_stream(
            ["mysql-bin.000003"], database="tenant_ddl", start_position=0, run=run
        )
        row_events, statements = etb.count_tenant_events(sql, "tenant_ddl")
        # tenant_ddl never writes a row -- only DDL.
        self.assertEqual(row_events, 0)
        # ALTER, CREATE, DROP -- three statements. The BEGIN ahead of them
        # must not inflate this count.
        self.assertEqual(statements, 3)

    def test_zero_and_zero_for_a_quiet_tenant(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        sql = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_quiet", start_position=1653, run=run
        )
        self.assertEqual(etb.count_tenant_events(sql, "tenant_quiet"), (0, 0))

    def test_never_raises_on_an_empty_stream(self):
        self.assertEqual(etb.count_tenant_events(b"", "tenant_a"), (0, 0))


class LastRotateTimestampTests(unittest.TestCase):
    def test_reads_the_last_rotate_events_timestamp(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        sql = etb.extract_tenant_stream(
            ["mysql-bin.000003", "mysql-bin.000004"], database="tenant_a", start_position=1653, run=run
        )
        self.assertEqual(etb.last_rotate_timestamp(sql), "2026-09-23 12:00:00")

    def test_none_when_no_rotate_event_is_present(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        # 000005 carries no ROTATE marker in the fixture -- the "currently
        # open file" case.
        sql = etb.extract_tenant_stream(["mysql-bin.000005"], database="tenant_a", start_position=0, run=run)
        self.assertIsNone(etb.last_rotate_timestamp(sql))

    def test_survives_the_database_filter(self):
        # A Rotate event belongs to no database -- must appear in a scoped
        # extract exactly as it does in an unscoped one.
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        scoped = etb.extract_tenant_stream(
            ["mysql-bin.000004"], database="tenant_quiet", start_position=0, run=run
        )
        self.assertEqual(etb.last_rotate_timestamp(scoped), "2026-09-23 12:00:00")


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
        self.assertEqual(result.row_events, 3)  # A1, AX, A2
        self.assertEqual(result.statements, 0)
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

    # A quiet tenant, or a --stop-datetime before a tenant's first
    # post-dump write, is applied (harmlessly empty) and reported as
    # zero, not refused.

    def test_a_quiet_tenant_is_always_applied_and_reports_zero(self):
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
        self.assertEqual((result.row_events, result.statements), (0, 0))
        # apply_stream (the "mysql" command) is ALWAYS called now, even for
        # a stream carrying nothing for the tenant -- harmless, and one
        # fewer code path to keep in sync with the count above.
        self.assertIn("mysql", [c[0] for c in run.calls])

    def test_a_stop_datetime_before_the_tenants_first_write_reports_zero(self):
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
        self.assertEqual((result.row_events, result.statements), (0, 0))

    # A tenant whose only post-dump events are DDL must be detected via
    # the statement count, not missed by row_events.

    def test_a_ddl_only_tenant_reports_nonzero_statements(self):
        run = FakeMysqlbinlog(SAMPLE_EVENTS)
        result = etb.restore_point_in_time(
            dump_text=DUMP_WITH_RESUME_POINT,
            binlog_paths=["mysql-bin.000003"],
            tenant_database="tenant_ddl",
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertEqual(result.row_events, 0)
        self.assertEqual(result.statements, 3)
        self.assertIn(b"ALTER TABLE posts ADD COLUMN body TEXT", result.sql)
        self.assertIn(b"CREATE TABLE tags (id INT PRIMARY KEY)", result.sql)
        self.assertIn(b"DROP TABLE tags", result.sql)
        # And it was actually applied -- not skipped because row_events==0.
        self.assertEqual(run.applied, result.sql)

    # Sort before slicing, check contiguity over the whole given list.

    def test_unsorted_two_file_list_no_longer_drops_the_later_file(self):
        # binlog_paths[resume_index:] on an UNSORTED list with resume file
        # 000004 at index 0 would slice to ["000004"] only, silently
        # dropping 000005, if the list were used as given rather than
        # sorted first.
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

    def test_a_ddl_only_tenant_exits_zero_and_reports_statements(self):
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
                            "tenant_ddl",
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
        self.assertIn("applied 0 row events and 3 statements for 'tenant_ddl'", stdout.getvalue())

    def test_warns_on_stderr_when_stop_datetime_is_later_than_the_binlogs_end(self):
        import contextlib
        import io
        import unittest.mock as mock

        os.environ["MYSQL_PWD"] = "pw"
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        try:
            with mock.patch("extract_tenant_binlog.subprocess.run", FakeMysqlbinlog(SAMPLE_EVENTS)):
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    rc = etb.main(
                        [
                            "--dump",
                            path,
                            "--tenant-database",
                            "tenant_a",
                            "--stop-datetime",
                            "2026-09-23 23:59:59",  # after the fixture's ROTATE at 12:00:00
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
        self.assertIn("the given binlogs end at 2026-09-23 12:00:00", stdout.getvalue())
        self.assertIn("WARNING", stderr.getvalue())
        self.assertIn("2026-09-23 12:00:00", stderr.getvalue())

    def test_no_warning_when_stop_datetime_is_within_the_binlogs_coverage(self):
        import contextlib
        import io
        import unittest.mock as mock

        os.environ["MYSQL_PWD"] = "pw"
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        try:
            with mock.patch("extract_tenant_binlog.subprocess.run", FakeMysqlbinlog(SAMPLE_EVENTS)):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    rc = etb.main(
                        [
                            "--dump",
                            path,
                            "--tenant-database",
                            "tenant_a",
                            "--stop-datetime",
                            "2026-09-23 00:00:00",  # before the fixture's ROTATE at 12:00:00
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
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

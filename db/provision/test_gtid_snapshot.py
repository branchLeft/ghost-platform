#!/usr/bin/env python3
"""Unit tests for gtid_snapshot.py and the GTID half of extract_tenant_binlog.py.

The end-to-end proof, against a model of the commit pipeline, is
infra/provisioning/scripts/test_gtid_recovery.py. See gtid_snapshot.md.
"""

from __future__ import annotations

import subprocess
import unittest

import bounded_snapshot
import extract_tenant_binlog as etb
import gtid_server_model as model
import gtid_snapshot as gs

A = "3e11fa47-71ca-11e1-9e33-c80aa9429562"
B = "9a0b1c2d-1111-2222-3333-444455556666"


class GtidSetTests(unittest.TestCase):
    def test_parse_and_format_round_trip_in_canonical_form(self):
        parsed = gs.parse_gtid_set(f"{B}:1-3:5,\n{A.upper()}:1-2:3-4:9")
        self.assertEqual(gs.format_gtid_set(parsed), f"{A}:1-4:9,{B}:1-3:5")

    def test_empty_text_is_the_empty_set(self):
        self.assertEqual(gs.parse_gtid_set(" \n"), {})
        self.assertEqual(gs.format_gtid_set({}), "")

    def test_malformed_sets_are_refused(self):
        for bad in ("nonsense", f"{A}", f"{A}:0", f"{A}:5-3", f"{A}:1-x", "1234:1-5"):
            with self.subTest(bad=bad), self.assertRaises(gs.GtidError):
                gs.parse_gtid_set(bad)

    def test_subset(self):
        whole = gs.parse_gtid_set(f"{A}:1-10,{B}:1-3")
        self.assertTrue(gs.is_subset(gs.parse_gtid_set(f"{A}:2-4:6"), whole))
        self.assertTrue(gs.is_subset({}, whole))
        self.assertFalse(gs.is_subset(gs.parse_gtid_set(f"{A}:1-11"), whole))
        self.assertFalse(gs.is_subset(gs.parse_gtid_set(f"{A}:4-12"), whole))
        self.assertFalse(gs.is_subset(gs.parse_gtid_set("11111111-2222-3333-4444-555555555555:1"), whole))


def _scan(*lines: str) -> gs.PurgedStatementScanner:
    scanner = gs.PurgedStatementScanner()
    for line in lines:
        scanner.feed(line)
    return scanner


class ScannerTests(unittest.TestCase):
    def test_reads_the_one_line_statement(self):
        scanner = _scan(f"SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{A}:1-5';\n")
        self.assertEqual(scanner.require_position(), f"{A}:1-5")

    def test_reads_a_statement_broken_over_lines(self):
        scanner = _scan(
            f"SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{A}:1-5,\n",
            f"{B}:1-7';\n",
        )
        self.assertEqual(scanner.require_position(), f"{A}:1-5,{B}:1-7")

    def test_reads_the_older_form_without_the_append_comment(self):
        self.assertEqual(_scan(f"SET @@GLOBAL.GTID_PURGED='{A}:1';").require_position(), f"{A}:1")

    def test_an_empty_set_is_a_position(self):
        self.assertEqual(_scan("SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '';").require_position(), "")

    def test_no_statement_is_not_a_position(self):
        with self.assertRaises(gs.NoGtidStatement):
            _scan("-- MySQL dump", "CREATE DATABASE `x`;").require_position()

    def test_a_row_that_looks_like_the_statement_cannot_forge_a_position(self):
        scanner = _scan("CREATE DATABASE `x`;\n", "USE `x`;\n", f"SET @@GLOBAL.GTID_PURGED='{A}:1-999';\n")
        with self.assertRaises(gs.NoGtidStatement):
            scanner.require_position()

    def test_two_statements_are_ambiguous(self):
        with self.assertRaises(gs.GtidError):
            _scan(f"SET @@GLOBAL.GTID_PURGED='{A}:1';", f"SET @@GLOBAL.GTID_PURGED='{A}:1-2';")

    def test_a_statement_cut_short_is_refused(self):
        with self.assertRaises(gs.GtidError):
            _scan(f"SET @@GLOBAL.GTID_PURGED='{A}:1-5,\n").require_position()

    def test_a_malformed_set_is_refused(self):
        with self.assertRaises(gs.GtidError):
            _scan("SET @@GLOBAL.GTID_PURGED='not-a-set';")

    def test_feed_bytes_ignores_everything_after_the_header(self):
        scanner = gs.PurgedStatementScanner()
        scanner.feed_bytes(b"CREATE DATABASE `x`;\n")
        self.assertTrue(scanner.finished)
        scanner.feed_bytes(f"SET @@GLOBAL.GTID_PURGED='{A}:1';\n".encode())
        self.assertIsNone(scanner.position)


class DumpArgumentTests(unittest.TestCase):
    def test_the_dump_is_single_transaction_with_the_gtid_set_and_nothing_that_locks(self):
        args = gs.dump_args("ghost_blog")
        gs.assert_lock_free_args(args)
        self.assertIn("--single-transaction", args)
        self.assertIn("--set-gtid-purged=ON", args)
        self.assertEqual(args[-2:], ["--databases", "ghost_blog"])

    def test_every_option_that_locks_or_replaces_the_position_is_refused(self):
        for extra in (
            "--lock-all-tables",
            "--lock-tables",
            "--lock-tables=true",
            "--source-data=2",
            "--master-data=2",
            "--flush-logs",
            "--flush-privileges",
            "--delete-source-logs",
            "-x",
            "-l",
            "-F",
        ):
            with self.subTest(extra=extra), self.assertRaises(gs.GtidError):
                gs.assert_lock_free_args([*gs.dump_args("ghost_blog"), extra])

    def test_a_dump_without_the_snapshot_or_the_set_is_refused(self):
        base = gs.dump_args("ghost_blog")
        for missing in ("--single-transaction", "--set-gtid-purged=ON"):
            with self.subTest(missing=missing), self.assertRaises(gs.GtidError):
                gs.assert_lock_free_args([a for a in base if a != missing])
        for other in ("--set-gtid-purged=OFF", "--set-gtid-purged=AUTO"):
            with self.subTest(other=other), self.assertRaises(gs.GtidError):
                gs.assert_lock_free_args([*[a for a in base if a != "--set-gtid-purged=ON"], other])


class TakeSnapshotTests(unittest.TestCase):
    def test_only_mysqldump_is_started_and_no_lock_is_asked_for(self):
        server = model.Server()
        factory = bounded_snapshot.ClientFactory(
            connection_args=["--host", "db"], password="p", env={}, popen=server.popen
        )
        dump = gs.take_gtid_snapshot(factory=factory, args=gs.dump_args("ghost_a"))
        list(dump.process.stdout)
        self.assertEqual(server.spawned, ["mysqldump"])
        self.assertEqual((server.lock_requests, server.global_lock_attempts), (0, 0))

    def test_a_refused_command_starts_nothing(self):
        server = model.Server()
        factory = bounded_snapshot.ClientFactory(
            connection_args=["--host", "db"], password="p", env={}, popen=server.popen
        )
        with self.assertRaises(gs.GtidError):
            gs.take_gtid_snapshot(factory=factory, args=[*gs.dump_args("ghost_a"), "--lock-all-tables"])
        self.assertEqual(server.spawned, [])


DUMP_WITH_SET = f"""\
SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{A}:1-5';
CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_a` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;
USE `tenant_a`;
"""


class RecoveryStartTests(unittest.TestCase):
    def test_a_gtid_dump_gives_its_set(self):
        start = etb.parse_dump_recovery_start(DUMP_WITH_SET, tenant_database="tenant_a")
        self.assertEqual(start, etb.RecoveryStart(log_file=None, position=None, gtid_set=f"{A}:1-5"))

    def test_a_file_and_position_dump_gives_its_position(self):
        text = "-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;\nUSE `tenant_a`;\n"
        start = etb.parse_dump_recovery_start(text, tenant_database="tenant_a")
        self.assertEqual(start, etb.RecoveryStart(log_file="mysql-bin.000003", position=1653, gtid_set=None))

    def test_both_forms_are_ambiguous(self):
        text = "-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;\n" + DUMP_WITH_SET
        with self.assertRaisesRegex(etb.ExtractError, "ambiguous"):
            etb.parse_dump_recovery_start(text, tenant_database="tenant_a")

    def test_neither_form_is_refused_and_names_both(self):
        with self.assertRaisesRegex(etb.ExtractError, "GTID_PURGED"):
            etb.parse_dump_recovery_start("USE `tenant_a`;\n", tenant_database="tenant_a")

    def test_an_undeclared_tenant_is_refused_for_a_gtid_dump_too(self):
        with self.assertRaisesRegex(etb.ExtractError, "not declared"):
            etb.parse_dump_recovery_start(DUMP_WITH_SET, tenant_database="tenant_zzz")

    def test_the_old_resume_point_reader_still_reads_only_file_and_position(self):
        with self.assertRaises(etb.ExtractError):
            etb.parse_dump_resume_point(DUMP_WITH_SET, tenant_database="tenant_a")


class ArgvTests(unittest.TestCase):
    def test_gtid_argv_skips_the_set_and_has_no_start_position(self):
        argv = etb.mysqlbinlog_argv(["a.000001"], database="t", exclude_gtids=f"{A}:1-5")
        self.assertEqual(argv, ["mysqlbinlog", f"--exclude-gtids={A}:1-5", "--skip-gtids", "--database=t", "a.000001"])

    def test_exactly_one_start_is_required(self):
        with self.assertRaises(etb.ExtractError):
            etb.mysqlbinlog_argv(["a.000001"], database="t")
        with self.assertRaises(etb.ExtractError):
            etb.mysqlbinlog_argv(["a.000001"], database="t", start_position=4, exclude_gtids=f"{A}:1")

    def test_position_zero_is_still_a_position(self):
        argv = etb.mysqlbinlog_argv(["a.000001"], database=None, start_position=0)
        self.assertEqual(argv[:2], ["mysqlbinlog", "--start-position=0"])


def _completed(stdout: str, returncode: int = 0):
    return subprocess.CompletedProcess([], returncode, stdout=stdout.encode(), stderr=b"boom")


PREVIOUS_ONE_MEMBER = (
    "# at 126\n#260101 00:00:00 server id 1  end_log_pos 197 CRC32 0x00000000 \tPrevious-GTIDs\n"
    f"# {A}:1-5\n# at 197\n"
)
PREVIOUS_TWO_MEMBERS = (
    "# at 126\n#260101 00:00:00 server id 1  end_log_pos 197 CRC32 0x00000000 \tPrevious-GTIDs\n"
    f"# {A}:1-5,\n# {B}:1-7\n# at 197\n"
)


class PreviousGtidsTests(unittest.TestCase):
    def test_parses_one_member_and_several(self):
        self.assertEqual(etb.parse_previous_gtids(PREVIOUS_ONE_MEMBER.encode()), f"{A}:1-5")
        self.assertEqual(etb.parse_previous_gtids(PREVIOUS_TWO_MEMBERS.encode()), f"{A}:1-5,{B}:1-7")

    def test_an_event_with_no_set_is_the_empty_set(self):
        text = "#260101 00:00:00 server id 1  end_log_pos 197 CRC32 0x00000000 \tPrevious-GTIDs\n# at 197\n"
        self.assertEqual(etb.parse_previous_gtids(text.encode()), "")

    def test_no_event_is_none(self):
        self.assertIsNone(etb.parse_previous_gtids(b"# at 4\n#260101 Start: binlog v 4\n"))

    def test_the_check_passes_when_the_first_file_begins_inside_the_dump(self):
        etb.assert_binlogs_cover_gtid_set("x.000001", f"{A}:1-9", run=lambda *a, **k: _completed(PREVIOUS_ONE_MEMBER))

    def test_the_check_fails_when_a_file_is_missing(self):
        with self.assertRaisesRegex(etb.ExtractError, "binlog gap"):
            etb.assert_binlogs_cover_gtid_set("x.000002", f"{A}:1-3", run=lambda *a, **k: _completed(PREVIOUS_ONE_MEMBER))

    def test_the_check_fails_on_a_binlog_written_without_gtids(self):
        with self.assertRaisesRegex(etb.ExtractError, "no Previous-GTIDs"):
            etb.assert_binlogs_cover_gtid_set("x.000001", f"{A}:1", run=lambda *a, **k: _completed("# at 4\n"))

    def test_the_check_fails_when_mysqlbinlog_does(self):
        with self.assertRaisesRegex(etb.ExtractError, "exited 1"):
            etb.assert_binlogs_cover_gtid_set("x.000001", f"{A}:1", run=lambda *a, **k: _completed("", 1))


if __name__ == "__main__":
    unittest.main()

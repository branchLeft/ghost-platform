#!/usr/bin/env python3
"""Unit tests for extract_tenant_binlog.py.

See test_extract_tenant_binlog.md#module-overview.
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
    """A fake event stream, filtered the way a real mysqlbinlog filters a
    real row-format binlog: on the table a row event targets, never a
    session's `USE`. See test_extract_tenant_binlog.md#fakemysqlbinlog."""

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
        self.applied_all: list[bytes] = []

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
            decode_rows = False
            files = []
            for arg in argv[1:]:
                if arg == "--base64-output=DECODE-ROWS":
                    decode_rows = True
                elif arg.startswith("--database="):
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
                    if stop_datetime is not None:
                        hour, minute_second = hhmmss.split(":", 1)
                        rotate_at = f"20{yymmdd[0:2]}-{yymmdd[2:4]}-{yymmdd[4:6]} {int(hour):02d}:{minute_second}"
                        if rotate_at > stop_datetime:
                            continue  # real mysqlbinlog stops before the closing Rotate
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

                if kind == "ROW" and decode_rows:
                    continue  # no --verbose: a row event prints no statement
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
            self.applied_all.append(input)
            return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

        raise AssertionError(f"unexpected command: {command}")


# AX/BX are cross-session writes, proving the filter follows the table, not
# the session. See test_extract_tenant_binlog.md#sample_events.
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
    ("mysql-bin.000003", 2600, None, "ROTATE:260923:11:00:00"),
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


# A nightly dump taken one schema at a time: each section opens with its own
# resume point, and the databases it declares are governed by that one.
# `mysql` rides in the first section, as the nightly dump puts it.
DUMP_IN_SECTIONS = """\
-- BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1653;
CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_a` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;
USE `tenant_a`;
CREATE TABLE `posts` (...);
CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mysql` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;
USE `mysql`;
-- BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000004', MASTER_LOG_POS=90;
CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tenant_b` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;
USE `tenant_b`;
CREATE TABLE `posts` (...);
"""


class SectionedDumpResumePointTests(unittest.TestCase):
    def test_each_database_resumes_from_the_section_that_declares_it(self):
        for tenant, expected in (
            ("tenant_a", ("mysql-bin.000003", 1653)),
            ("mysql", ("mysql-bin.000003", 1653)),
            ("tenant_b", ("mysql-bin.000004", 90)),
        ):
            with self.subTest(tenant=tenant):
                self.assertEqual(etb.parse_dump_resume_point(DUMP_IN_SECTIONS, tenant_database=tenant), expected)
                self.assertEqual(
                    etb.parse_dump_recovery_start(DUMP_IN_SECTIONS, tenant_database=tenant),
                    etb.RecoveryStart(expected[0], expected[1], None),
                )

    def test_a_database_the_dump_does_not_declare_is_refused(self):
        with self.assertRaisesRegex(etb.ExtractError, "not declared"):
            etb.parse_dump_recovery_start(DUMP_IN_SECTIONS, tenant_database="tenant_c")

    def test_a_database_declared_before_any_section_comment_is_refused(self):
        text = "USE `tenant_a`;\n" + DUMP_IN_SECTIONS
        with self.assertRaisesRegex(etb.ExtractError, "before any"):
            etb.parse_dump_recovery_start(text, tenant_database="tenant_a")

    def test_a_dump_with_both_forms_is_ambiguous(self):
        text = "-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000001', MASTER_LOG_POS=4;\n" + DUMP_IN_SECTIONS
        with self.assertRaisesRegex(etb.ExtractError, "ambiguous"):
            etb.parse_dump_recovery_start(text, tenant_database="tenant_b")
        with self.assertRaisesRegex(etb.ExtractError, "ambiguous"):
            etb.parse_dump_resume_point(text, tenant_database="tenant_b")

    def test_sections_and_a_gtid_set_are_ambiguous(self):
        text = "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:1-5';\n" + DUMP_IN_SECTIONS
        with self.assertRaisesRegex(etb.ExtractError, "ambiguous"):
            etb.parse_dump_recovery_start(text, tenant_database="tenant_b")

    def test_the_bare_form_is_unchanged_and_the_section_form_is_not_the_bare_form(self):
        self.assertIsNone(etb.SOURCE_DATA_PATTERN.match(DUMP_IN_SECTIONS.splitlines()[0]))
        self.assertEqual(
            etb.parse_dump_resume_point(DUMP_WITH_RESUME_POINT, tenant_database="tenant_b"), ("mysql-bin.000003", 1653)
        )

    def test_a_reader_of_only_the_bare_form_finds_none_in_a_sectioned_dump(self):
        # Fail closed: the shape every earlier reader looks for is absent.
        self.assertFalse(
            [line for line in DUMP_IN_SECTIONS.splitlines() if etb.SOURCE_DATA_PATTERN.match(line)]
        )


# What happened on the instance after the nightly dump, in binlog order. A
# new tenant (tenant_new) and an account were created after the dump, by an
# admin session with no `USE`; the account has no database, the creation of
# tenant_new is tagged either way by the parametrised tests.
def instance_events(create_database_tagged_as: str | None) -> list:
    return [
        ("mysql-bin.000003", 1650, None, "DDL:CREATE USER 'before_dump'@'localhost'"),
        ("mysql-bin.000003", 1700, None, "DDL:CREATE USER 'after_dump'@'localhost' IDENTIFIED BY 'x'"),
        ("mysql-bin.000003", 1800, create_database_tagged_as, "DDL:CREATE DATABASE tenant_new"),
        ("mysql-bin.000003", 1900, "tenant_new", "ROW:N1-new-tenant-row"),
        ("mysql-bin.000003", 2000, "tenant_a", "ROW:A1-post-section"),
        ("mysql-bin.000003", 2100, None, "DDL:ALTER USER 'after_dump'@'localhost'\nIDENTIFIED BY 'y'"),
        ("mysql-bin.000003", 2600, None, "ROTATE:260923:11:00:00"),
        ("mysql-bin.000004", 50, "tenant_b", "ROW:B0-before-its-section-must-never-appear"),
        ("mysql-bin.000004", 200, "tenant_b", "ROW:B1-post-section"),
        ("mysql-bin.000004", 300, None, "DDL:GRANT SELECT ON tenant_new.* TO 'after_dump'@'localhost'"),
        ("mysql-bin.000004", 400, "tenant_a", "DDL:CREATE DATABASE tenant_a"),
        ("mysql-bin.000004", 500, "tenant_new", "ROW:N2-new-tenant-row"),
        ("mysql-bin.000004", 800, None, "ROTATE:260923:12:00:00"),
    ]


class InstanceRestoreTests(unittest.TestCase):
    FILES = ("mysql-bin.000003", "mysql-bin.000004")

    def setUp(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False)  # noqa: SIM115
        handle.write(DUMP_IN_SECTIONS)
        handle.close()
        self.dump_path = handle.name
        self.addCleanup(os.unlink, handle.name)

    def _restore(self, run):
        return etb.restore_instance(
            dump_path=self.dump_path,
            binlog_paths=list(self.FILES),
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )

    def test_the_per_database_replay_alone_loses_a_new_database_and_an_account(self):
        # The sequence the runbook used to give: every declared database from
        # its own position, nothing else. This is the gap the instance pass closes.
        for tagged in (None, "tenant_new"):
            with self.subTest(creation_tagged_as=tagged):
                run = FakeMysqlbinlog(instance_events(tagged))
                for name in ("tenant_a", "mysql", "tenant_b"):
                    etb.restore_point_in_time(
                        dump_text=DUMP_IN_SECTIONS,
                        binlog_paths=list(self.FILES),
                        tenant_database=name,
                        apply_socket_path="/tmp/mysqld.sock",
                        apply_user="root",
                        apply_password="pw",
                        run=run,
                    )
                applied = b"\n".join(run.applied_all)
                self.assertNotIn(b"after_dump", applied)
                self.assertNotIn(b"N1-new-tenant-row", applied)
                self.assertNotIn(b"N2-new-tenant-row", applied)

    def test_the_instance_restore_recovers_an_account_and_a_database_created_after_the_dump(self):
        for tagged in (None, "tenant_new"):
            with self.subTest(creation_tagged_as=tagged):
                run = FakeMysqlbinlog(instance_events(tagged))
                restored = self._restore(run)
                applied = b"\n".join(run.applied_all)
                self.assertIn(b"CREATE USER 'after_dump'@'localhost' IDENTIFIED BY 'x'", applied)
                self.assertIn(b"ALTER USER 'after_dump'@'localhost'\nIDENTIFIED BY 'y'", applied)
                self.assertIn(b"GRANT SELECT ON tenant_new.*", applied)
                self.assertIn(b"N1-new-tenant-row", applied)
                self.assertIn(b"N2-new-tenant-row", applied)
                self.assertEqual(restored.new_databases, ("tenant_new",))
                self.assertEqual(sorted(restored.replays), ["mysql", "tenant_a", "tenant_b", "tenant_new"])

    def test_the_new_databases_creation_is_applied_exactly_once_however_the_server_tagged_it(self):
        # Idempotence: if the filtered replay of tenant_new carried its own
        # CREATE DATABASE, the instance pass's would fail on a database that exists.
        for tagged in (None, "tenant_new"):
            with self.subTest(creation_tagged_as=tagged):
                run = FakeMysqlbinlog(instance_events(tagged))
                self._restore(run)
                applied = b"\n".join(run.applied_all)
                self.assertEqual(applied.count(b"CREATE DATABASE tenant_new"), 1)

    def test_nothing_from_before_the_dump_and_no_recreation_of_a_declared_database(self):
        run = FakeMysqlbinlog(instance_events(None))
        self._restore(run)
        applied = b"\n".join(run.applied_all)
        self.assertNotIn(b"before_dump", applied)
        # The instance pass (the first thing applied) never re-creates a
        # database the dump declares; that one is the declared replay's own.
        self.assertNotIn(b"CREATE DATABASE tenant_a", run.applied_all[0])

    def test_each_declared_database_still_starts_from_its_own_section(self):
        run = FakeMysqlbinlog(instance_events(None))
        restored = self._restore(run)
        self.assertIn(b"A1-post-section", restored.replays["tenant_a"].sql)
        self.assertIn(b"B1-post-section", restored.replays["tenant_b"].sql)
        self.assertNotIn(b"B0-before-its-section", restored.replays["tenant_b"].sql)
        scoped = {
            next(a for a in call if a.startswith("--database=")): next(a for a in call if a.startswith("--start-position="))
            for call in run.calls
            if call[0] == "mysqlbinlog" and any(a.startswith("--database=") for a in call)
        }
        self.assertEqual(
            scoped,
            {
                "--database=tenant_a": "--start-position=1653",
                "--database=mysql": "--start-position=1653",
                "--database=tenant_b": "--start-position=90",
                "--database=tenant_new": "--start-position=1653",
            },
        )

    def test_the_instance_pass_runs_first_and_reads_no_row_events(self):
        run = FakeMysqlbinlog(instance_events(None))
        self._restore(run)
        first = run.calls[0]
        self.assertEqual(first[:3], ["mysqlbinlog", "--start-position=1653", "--base64-output=DECODE-ROWS"])
        self.assertFalse([a for a in first if a.startswith("--database=")])
        self.assertIn(b"CREATE USER", run.applied_all[0])

    def test_a_stop_datetime_reaches_the_instance_pass(self):
        run = FakeMysqlbinlog(instance_events(None))
        etb.restore_instance(
            dump_path=self.dump_path,
            binlog_paths=list(self.FILES),
            stop_datetime="2026-09-23 12:00:00",
            apply_socket_path="/tmp/mysqld.sock",
            apply_user="root",
            apply_password="pw",
            run=run,
        )
        self.assertIn("--stop-datetime=2026-09-23 12:00:00", run.calls[0])

    def test_a_bare_dump_restores_the_same_way(self):
        with open(self.dump_path, "w", encoding="utf-8") as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
        restored = self._restore(FakeMysqlbinlog(instance_events(None)))
        self.assertEqual(restored.new_databases, ("tenant_new",))

    def test_a_dump_with_no_resume_point_is_refused_before_any_mysqlbinlog_call(self):
        with open(self.dump_path, "w", encoding="utf-8") as handle:
            handle.write("USE `tenant_a`;\n")
        run = FakeMysqlbinlog(instance_events(None))
        with self.assertRaisesRegex(etb.ExtractError, "no resume point"):
            self._restore(run)
        self.assertEqual(run.calls, [])

    def test_a_failed_instance_pass_applies_nothing(self):
        run = FakeMysqlbinlog(instance_events(None), fail=True)
        with self.assertRaises(etb.ExtractError):
            self._restore(run)
        self.assertEqual(run.applied_all, [])

    def test_main_all_databases_runs_the_instance_restore(self):
        import contextlib
        import io
        from unittest import mock

        os.environ["MYSQL_PWD"] = "pw"
        self.addCleanup(os.environ.pop, "MYSQL_PWD", None)
        stdout = io.StringIO()
        with (
            mock.patch("extract_tenant_binlog.subprocess.run", FakeMysqlbinlog(instance_events(None))),
            contextlib.redirect_stdout(stdout),
        ):
            rc = etb.main(
                ["--dump", self.dump_path, "--all-databases", "--apply-socket", "/tmp/mysqld.sock",
                 "--apply-user", "root", *self.FILES]
            )
        self.assertEqual(rc, 0)
        self.assertIn("created 'tenant_new'", stdout.getvalue())

    def test_main_wants_exactly_one_of_tenant_database_and_all_databases(self):
        import contextlib
        import io

        os.environ["MYSQL_PWD"] = "pw"
        self.addCleanup(os.environ.pop, "MYSQL_PWD", None)
        for extra in ([], ["--all-databases", "--tenant-database", "tenant_a"]):
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                rc = etb.main(["--dump", self.dump_path, *extra, "--apply-socket", "/s", "--apply-user", "root", *self.FILES])
                self.assertEqual(rc, 1)


class SelectInstanceStatementsTests(unittest.TestCase):
    HEADER = "#260923 11:22:09 server id 1  end_log_pos 100 CRC32 0x7cce0723 \tQuery\tthread_id=12\texec_time=0\terror_code=0"
    ROW_HEADER = "#260923 11:22:09 server id 1  end_log_pos 200 CRC32 0x7cce0723 \tTable_map: `t`.`posts` mapped to number 1"

    def _event(self, statement):
        return f"# at 4\n{self.HEADER}\nSET TIMESTAMP=1/*!*/;\n{statement}\n/*!*/;\n"

    def _stream(self, *statements, rows=True):
        body = "".join(self._event(s) for s in statements)
        if rows:
            body += f"# at 5\n{self.ROW_HEADER}\n"
        return ("/*!50530 SET @@SESSION.PSEUDO_SLAVE_MODE=1*/;\nDELIMITER /*!*/;\n" + body + "DELIMITER ;\n# End of log file\n").encode()

    def test_keeps_account_statements_and_creation_of_an_undeclared_database_only(self):
        sql = self._stream(
            "CREATE USER 'u'@'h'", "ALTER USER 'u'@'h' IDENTIFIED BY 'p'", "DROP USER 'v'@'h'", "RENAME USER 'a'@'h' TO 'b'@'h'",
            "GRANT ALL ON x.* TO 'u'@'h'", "revoke ALL ON x.* FROM 'u'@'h'", "SET PASSWORD FOR 'u'@'h' = 'p'",
            "CREATE ROLE r", "SET DEFAULT ROLE r TO 'u'@'h'",
            "CREATE DATABASE `fresh` /*!40100 DEFAULT CHARACTER SET utf8mb4 */", "CREATE SCHEMA other",
            "CREATE DATABASE `declared`", "CREATE TABLE t (id INT)", "ALTER TABLE t ADD c INT", "BEGIN", "DROP DATABASE fresh",
        )
        out, new, kept = etb.select_instance_statements(sql, declared={"declared"})
        text = out.decode()
        self.assertEqual(new, ["fresh", "other"])
        self.assertEqual(kept, 11)
        for wanted in ("CREATE USER", "ALTER USER", "DROP USER", "RENAME USER", "GRANT ALL", "revoke ALL", "SET PASSWORD",
                       "CREATE ROLE", "SET DEFAULT ROLE", "`fresh`", "CREATE SCHEMA other"):
            self.assertIn(wanted, text)
        for unwanted in ("`declared`", "CREATE TABLE", "ALTER TABLE", "BEGIN", "DROP DATABASE", "Table_map"):
            self.assertNotIn(unwanted, text)

    def test_the_wrapper_survives_so_the_result_still_applies(self):
        out, _, _ = etb.select_instance_statements(self._stream("CREATE USER 'u'@'h'"), declared=set())
        self.assertTrue(out.startswith(b"/*!50530"))
        self.assertIn(b"DELIMITER /*!*/;", out)
        self.assertTrue(out.rstrip().endswith(b"# End of log file"))

    def test_a_database_created_twice_is_reported_once(self):
        _, new, kept = etb.select_instance_statements(
            self._stream("CREATE DATABASE a", "CREATE DATABASE a"), declared=set()
        )
        self.assertEqual((new, kept), (["a"], 1))

    def test_without_database_creation_removes_only_that_databases_creation(self):
        sql = self._stream("CREATE DATABASE a", "CREATE DATABASE b", "CREATE TABLE t (id INT)")
        out = etb.without_database_creation(sql, "a").decode()
        self.assertNotIn("CREATE DATABASE a", out)
        self.assertIn("CREATE DATABASE b", out)
        self.assertIn("CREATE TABLE t", out)
        self.assertIn("Table_map", out)
        self.assertTrue(out.rstrip().endswith("# End of log file"))

    def test_a_stream_with_no_events_comes_back_as_it_was(self):
        out, new, kept = etb.select_instance_statements(b"nothing here\n", declared=set())
        self.assertEqual((out, new, kept), (b"nothing here\n", [], 0))


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


class HorizonWarningTests(unittest.TestCase):
    """The warning fires only when the stop is really later than the last
    given file reaches, judged from a separate unfiltered pass over that
    file, with the two instants compared as datetimes."""

    def _run_main(self, stop, files):
        import contextlib
        import io
        import unittest.mock as mock

        os.environ["MYSQL_PWD"] = "pw"
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
            handle.write(DUMP_WITH_RESUME_POINT)
            path = handle.name
        fake = FakeMysqlbinlog(SAMPLE_EVENTS)
        try:
            with mock.patch("extract_tenant_binlog.subprocess.run", fake):
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    rc = etb.main(
                        ["--dump", path, "--tenant-database", "tenant_a", "--stop-datetime", stop]
                        + ["--apply-socket", "/tmp/mysqld.sock", "--apply-user", "root"]
                        + files
                    )
        finally:
            del os.environ["MYSQL_PWD"]
            os.unlink(path)
        self.assertEqual(rc, 0)
        return stdout.getvalue(), stderr.getvalue(), fake

    def test_silent_on_a_complete_list_with_a_mid_file_stop(self):
        # Stop falls inside 000004, before its closing Rotate (12:00:00): the
        # stop-limited extract carries only 000003's Rotate (11:00:00).
        stdout, stderr, _ = self._run_main("2026-09-23 11:59:00", ["mysql-bin.000003", "mysql-bin.000004"])
        self.assertIn("the given binlogs end at 2026-09-23 12:00:00", stdout)
        self.assertEqual(stderr, "")

    def test_fires_when_the_last_file_is_left_out(self):
        stdout, stderr, _ = self._run_main("2026-09-23 11:59:00", ["mysql-bin.000003"])
        self.assertIn("the given binlogs end at 2026-09-23 11:00:00", stdout)
        self.assertIn("WARNING", stderr)

    def test_unpadded_hour_is_compared_as_a_time_not_a_string(self):
        # "9:05:00" sorts after "12:00:00" as a string, but is earlier.
        _, stderr, _ = self._run_main("2026-09-23 9:05:00", ["mysql-bin.000003", "mysql-bin.000004"])
        self.assertEqual(stderr, "")

    def test_horizon_comes_from_an_unfiltered_pass_over_the_last_file_only(self):
        _, _, fake = self._run_main("2026-09-23 11:59:00", ["mysql-bin.000003", "mysql-bin.000004"])
        probes = [c for c in fake.calls if c[0] == "mysqlbinlog" and c[1:] == ["mysql-bin.000004"]]
        self.assertEqual(len(probes), 1)

    def test_a_failed_horizon_pass_leaves_the_horizon_unknown(self):
        failing = FakeMysqlbinlog(SAMPLE_EVENTS, fail=True)
        self.assertIsNone(etb.binlogs_coverage_end("mysql-bin.000004", run=failing))


class ParseUtcDatetimeTests(unittest.TestCase):
    def test_accepts_an_unpadded_hour(self):
        self.assertEqual(etb.parse_utc_datetime("2026-09-23 9:05:00").hour, 9)

    def test_accepts_the_t_separated_and_date_only_forms(self):
        self.assertIsNotNone(etb.parse_utc_datetime("2026-09-23T09:05:00"))
        self.assertIsNotNone(etb.parse_utc_datetime("2026-09-23"))

    def test_none_for_garbage(self):
        self.assertIsNone(etb.parse_utc_datetime("tomorrow-ish"))


if __name__ == "__main__":
    unittest.main()

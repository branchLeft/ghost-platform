#!/usr/bin/env python3
"""Unit tests for ship_binlogs.py.

The marker-file resume logic is the property worth the most coverage here:
a bug that re-ships an already-shipped log is wasted work, but a bug that
skips one silently breaks the point-in-time-replay chain the restore drill
depends on -- there is no second signal that would catch a gap.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

import ship_binlogs as sb


class FakeRun:
    def __init__(self, show_binary_logs=None, fail_command=None, fail_log=None):
        self.calls = []
        self.show_binary_logs = show_binary_logs or []
        self.fail_command = fail_command
        self.fail_log = fail_log

    def __call__(self, argv, env=None, capture_output=None, text=None, check=None):
        self.calls.append(list(argv))
        command = argv[0]

        if command == self.fail_command:
            log_name = argv[-1] if command == "mysqlbinlog" else None
            if self.fail_log is None or log_name == self.fail_log:
                return subprocess.CompletedProcess(argv, 1, stdout=b"", stderr=b"boom")

        if command == "mysql":
            sql = argv[argv.index("-e") + 1]
            if sql == "FLUSH BINARY LOGS;":
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
            if sql == "SHOW BINARY LOGS;":
                rows = "\n".join(f"{name}\t177" for name in self.show_binary_logs)
                return subprocess.CompletedProcess(argv, 0, stdout=rows + "\n" if rows else "", stderr="")
            raise AssertionError(f"unexpected SQL: {sql}")

        if command == "mysqlbinlog":
            out_dir = next(a for a in argv if a.startswith("--result-file=")).split("=", 1)[1]
            log_name = argv[-1]
            with open(os.path.join(out_dir, log_name), "wb") as f:
                f.write(f"RAW:{log_name}".encode())
            return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

        if command == "age":
            out_path = argv[argv.index("-o") + 1]
            in_path = argv[-1]
            with open(in_path, "rb") as src, open(out_path, "wb") as dst:
                dst.write(b"AGE:" + src.read())
            return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

        raise AssertionError(f"unexpected command: {command}")


class ListBinaryLogsTests(unittest.TestCase):
    def test_parses_names_in_order(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        names = sb.list_binary_logs(host="10.20.1.20", password="pw", run=run)
        self.assertEqual(names, ["mysql-bin.000001", "mysql-bin.000002"])


class LogsToShipTests(unittest.TestCase):
    def test_no_marker_ships_everything_retained(self):
        self.assertEqual(
            sb.logs_to_ship(["a", "b", "c"], None), ["a", "b", "c"]
        )

    def test_resumes_after_the_marker(self):
        self.assertEqual(sb.logs_to_ship(["a", "b", "c"], "a"), ["b", "c"])

    def test_nothing_pending_when_marker_is_the_newest_closed_log(self):
        self.assertEqual(sb.logs_to_ship(["a", "b", "c"], "c"), [])

    def test_a_marker_that_has_aged_out_of_retention_ships_everything_left(self):
        # The marked log was purged by binlog_expire_logs_seconds before this
        # run happened -- treat that as "nothing to resume from", not an error.
        self.assertEqual(sb.logs_to_ship(["b", "c"], "a"), ["b", "c"])


class MarkerFileTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.path = os.path.join(self.dir, "nested", "last-shipped")

    def test_round_trips(self):
        sb.save_marker(self.path, "mysql-bin.000005")
        self.assertEqual(sb.load_marker(self.path), "mysql-bin.000005")

    def test_missing_file_reads_as_none(self):
        self.assertIsNone(sb.load_marker(os.path.join(self.dir, "does-not-exist")))

    def test_no_temp_file_left_behind(self):
        sb.save_marker(self.path, "mysql-bin.000005")
        leftovers = [f for f in os.listdir(os.path.dirname(self.path)) if f.startswith(".ship-binlogs-")]
        self.assertEqual(leftovers, [])


class RunShipTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.marker_path = os.path.join(self.dir, "last-shipped")
        self.uploads = []

    def _fake_upload(self, **kwargs):
        self.uploads.append(kwargs)

    def _run_ship(self, run, marker_path=None):
        return sb.run_ship(
            host="10.20.1.20",
            password="pw",
            recipient="age1recipient",
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            marker_path=marker_path or self.marker_path,
            run=run,
            upload=self._fake_upload,
        )

    def test_never_ships_the_currently_open_log(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        shipped = self._run_ship(run)
        self.assertEqual(shipped, ["mysql-bin.000001"])

    def test_flushes_before_listing(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        self._run_ship(run)
        commands_in_order = [c[0] for c in run.calls]
        self.assertEqual(commands_in_order[0], "mysql")
        flush_call = next(c for c in run.calls if "FLUSH BINARY LOGS;" in c)
        list_call = next(c for c in run.calls if "SHOW BINARY LOGS;" in c)
        self.assertLess(run.calls.index(flush_call), run.calls.index(list_call))

    def test_advances_the_marker_after_each_successful_ship(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003"])
        shipped = self._run_ship(run)
        self.assertEqual(shipped, ["mysql-bin.000001", "mysql-bin.000002"])
        self.assertEqual(sb.load_marker(self.marker_path), "mysql-bin.000002")
        self.assertEqual(len(self.uploads), 2)

    def test_a_second_run_with_no_new_closed_logs_ships_nothing(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        self._run_ship(run)
        second = self._run_ship(
            FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        )
        self.assertEqual(second, [])
        self.assertEqual(len(self.uploads), 1)

    def test_a_failure_partway_through_leaves_the_marker_at_the_last_success(self):
        run = FakeRun(
            show_binary_logs=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003"],
            fail_command="mysqlbinlog",
            fail_log="mysql-bin.000002",
        )
        with self.assertRaises(sb.ShipError):
            self._run_ship(run)
        self.assertEqual(sb.load_marker(self.marker_path), "mysql-bin.000001")
        self.assertEqual(len(self.uploads), 1)

    def test_the_next_run_resumes_at_the_failed_log_not_after_it(self):
        run1 = FakeRun(
            show_binary_logs=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003"],
            fail_command="mysqlbinlog",
            fail_log="mysql-bin.000002",
        )
        with self.assertRaises(sb.ShipError):
            self._run_ship(run1)

        run2 = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003"])
        shipped = self._run_ship(run2)
        self.assertEqual(shipped, ["mysql-bin.000002"])

    def test_object_keys_are_namespaced_under_binlogs(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        self._run_ship(run)
        self.assertEqual(self.uploads[0]["key"], "binlogs/db1-mysql-bin.000001.age")


if __name__ == "__main__":
    unittest.main()

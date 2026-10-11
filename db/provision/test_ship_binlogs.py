#!/usr/bin/env python3
"""Unit tests for ship_binlogs.py.

The marker-file resume logic is the property worth the most coverage here:
a bug that re-ships an already-shipped log is wasted work, but a bug that
skips one silently breaks the point-in-time-replay chain the restore drill
depends on -- there is no second signal that would catch a gap. The
server-uuid identity check gets equal coverage: a marker surviving a
data-directory rebuild while naming a log the new incarnation later reaches
by coincidence must never be read as a valid resume point.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import ship_binlogs as sb

UUID_A = "aaaaaaaa-0000-0000-0000-000000000000"
UUID_B = "bbbbbbbb-1111-1111-1111-111111111111"


class FakeRun:
    def __init__(self, show_binary_logs=None, fail_command=None, fail_log=None, server_uuid=UUID_A):
        self.calls = []
        self.show_binary_logs = show_binary_logs or []
        self.fail_command = fail_command
        self.fail_log = fail_log
        self.server_uuid = server_uuid

    def __call__(self, argv, env=None, capture_output=None, text=None, check=None):
        self.calls.append(list(argv))
        command = argv[0]

        if command == self.fail_command:
            log_name = argv[-1] if command == "mysqlbinlog" else None
            if self.fail_log is None or log_name == self.fail_log:
                return subprocess.CompletedProcess(argv, 1, stdout=b"", stderr=b"boom")

        if command == "mysql":
            sql = argv[argv.index("-e") + 1]
            if sql == "SELECT @@server_uuid;":
                return subprocess.CompletedProcess(argv, 0, stdout=f"{self.server_uuid}\n", stderr="")
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


class GetServerUuidTests(unittest.TestCase):
    def test_reads_the_server_uuid(self):
        run = FakeRun(server_uuid=UUID_A)
        self.assertEqual(sb.get_server_uuid(socket_path="/tmp/mysqld.sock", password="pw", run=run), UUID_A)

    def test_raises_on_empty_output(self):
        run = FakeRun(server_uuid="")
        with self.assertRaises(sb.ShipError):
            sb.get_server_uuid(socket_path="/tmp/mysqld.sock", password="pw", run=run)


class ConnectsOverSocketTests(unittest.TestCase):
    def test_list_binary_logs_uses_socket_not_host(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        sb.list_binary_logs(socket_path="/opt/branchleft/db/run/mysqld/mysqld.sock", password="pw", run=run)
        call = run.calls[0]
        self.assertIn("--socket", call)
        self.assertNotIn("--host", call)

    def test_fetch_raw_binlog_uses_socket_not_host(self):
        run = FakeRun()
        with tempfile.TemporaryDirectory() as tmp:
            sb.fetch_raw_binlog(
                socket_path="/opt/branchleft/db/run/mysqld/mysqld.sock",
                password="pw",
                log_name="mysql-bin.000001",
                out_dir=tmp,
                run=run,
            )
        call = run.calls[0]
        self.assertIn("--socket", call)
        self.assertNotIn("--host", call)


class ListBinaryLogsTests(unittest.TestCase):
    def test_parses_names_in_order(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        names = sb.list_binary_logs(socket_path="/tmp/mysqld.sock", password="pw", run=run)
        self.assertEqual(names, ["mysql-bin.000001", "mysql-bin.000002"])


class ObjectKeyTests(unittest.TestCase):
    def test_namespaces_under_the_server_uuid(self):
        self.assertEqual(
            sb.object_key_for(UUID_A, "mysql-bin.000001"),
            f"binlogs/{UUID_A}/db1-mysql-bin.000001.age",
        )

    def test_same_log_name_from_two_incarnations_never_collides(self):
        before = sb.object_key_for(UUID_A, "mysql-bin.000001")
        after = sb.object_key_for(UUID_B, "mysql-bin.000001")
        self.assertNotEqual(before, after)


class LogsToShipTests(unittest.TestCase):
    def test_no_marker_ships_everything_retained(self):
        self.assertEqual(sb.logs_to_ship(["a", "b", "c"], None, UUID_A), ["a", "b", "c"])

    def test_resumes_after_the_marker(self):
        marker = sb.Marker(UUID_A, "a")
        self.assertEqual(sb.logs_to_ship(["a", "b", "c"], marker, UUID_A), ["b", "c"])

    def test_nothing_pending_when_marker_is_the_newest_closed_log(self):
        marker = sb.Marker(UUID_A, "c")
        self.assertEqual(sb.logs_to_ship(["a", "b", "c"], marker, UUID_A), [])

    def test_a_marker_that_has_aged_out_of_retention_ships_everything_left(self):
        marker = sb.Marker(UUID_A, "a")
        self.assertEqual(sb.logs_to_ship(["b", "c"], marker, UUID_A), ["b", "c"])

    def test_a_marker_from_a_different_server_incarnation_is_never_trusted(self):
        # The critical case: log name "b" genuinely exists in the CURRENT
        # incarnation's retained list (a coincidence after a rebuild), but
        # the marker was written by a previous, different incarnation. A
        # name match alone must not be read as a valid resume point.
        marker = sb.Marker(UUID_A, "b")
        self.assertEqual(sb.logs_to_ship(["a", "b", "c"], marker, UUID_B), ["a", "b", "c"])


class MarkerFileTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.path = os.path.join(self.dir, "nested", "last-shipped")

    def test_round_trips(self):
        sb.save_marker(self.path, UUID_A, "mysql-bin.000005")
        marker = sb.load_marker(self.path)
        self.assertEqual(marker.server_uuid, UUID_A)
        self.assertEqual(marker.log_name, "mysql-bin.000005")

    def test_missing_file_reads_as_none(self):
        self.assertIsNone(sb.load_marker(os.path.join(self.dir, "does-not-exist")))

    def test_a_single_token_legacy_file_reads_as_none_not_a_crash(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("mysql-bin.000005")
        self.assertIsNone(sb.load_marker(self.path))

    def test_no_temp_file_left_behind(self):
        sb.save_marker(self.path, UUID_A, "mysql-bin.000005")
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
            socket_path="/tmp/mysqld.sock",
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

    def test_fetches_the_server_uuid_before_flushing_or_listing(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        self._run_ship(run)
        sql_calls = [c[c.index("-e") + 1] for c in run.calls if c[0] == "mysql"]
        self.assertEqual(
            sql_calls, ["SELECT @@server_uuid;", "FLUSH BINARY LOGS;", "SHOW BINARY LOGS;"]
        )

    def test_advances_the_marker_after_each_successful_ship(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003"])
        shipped = self._run_ship(run)
        self.assertEqual(shipped, ["mysql-bin.000001", "mysql-bin.000002"])
        marker = sb.load_marker(self.marker_path)
        self.assertEqual(marker.server_uuid, UUID_A)
        self.assertEqual(marker.log_name, "mysql-bin.000002")
        self.assertEqual(len(self.uploads), 2)

    def test_a_second_run_with_no_new_closed_logs_ships_nothing(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        self._run_ship(run)
        second = self._run_ship(FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"]))
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
        marker = sb.load_marker(self.marker_path)
        self.assertEqual(marker.log_name, "mysql-bin.000001")
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

    def test_object_keys_are_namespaced_under_binlogs_and_the_server_uuid(self):
        run = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"])
        self._run_ship(run)
        self.assertEqual(self.uploads[0]["key"], f"binlogs/{UUID_A}/db1-mysql-bin.000001.age")

    def test_a_rebuild_reusing_old_log_names_ships_everything_under_the_new_incarnation(self):
        # Simulates host loss: the marker on a surviving OS disk still names
        # a log from the old incarnation, and the freshly-initialised MySQL
        # happens to reach the *same* log name again. The old marker must
        # not suppress shipping any of the new incarnation's logs.
        run1 = FakeRun(show_binary_logs=["mysql-bin.000001", "mysql-bin.000002"], server_uuid=UUID_A)
        self._run_ship(run1)
        marker_before = sb.load_marker(self.marker_path)
        self.assertEqual(marker_before.server_uuid, UUID_A)
        self.assertEqual(marker_before.log_name, "mysql-bin.000001")

        run2 = FakeRun(
            show_binary_logs=["mysql-bin.000001", "mysql-bin.000002", "mysql-bin.000003"],
            server_uuid=UUID_B,
        )
        shipped = self._run_ship(run2)
        # Without the incarnation check, "mysql-bin.000001" being present in
        # run2's own list too would be misread as the resume point, and
        # "mysql-bin.000002" would be silently skipped instead of shipped.
        self.assertEqual(shipped, ["mysql-bin.000001", "mysql-bin.000002"])
        self.assertEqual(self.uploads[-1]["key"], f"binlogs/{UUID_B}/db1-mysql-bin.000002.age")


class RunStatusTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.dir = os.path.join(tmp.name, "m")
        self.path = os.path.join(self.dir, sb.STATUS_FILENAME)

    def _text(self):
        with open(self.path, encoding="utf-8") as handle:
            return handle.read()

    def _assert_no_raise(self, **kwargs):
        try:
            sb.record_run_status(succeeded=True, now=1.0, **kwargs)
        except Exception as exc:  # the property under test is that nothing escapes
            self.fail(f"record_run_status raised {exc!r}")

    def test_a_success_publishes_the_status_and_the_time(self):
        sb.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000.4)
        text = self._text()
        self.assertIn("db_binlog_ship_last_run_success 1\n", text)
        self.assertIn("db_binlog_ship_last_success_timestamp_seconds 1790000000\n", text)

    def test_a_failure_keeps_the_previous_success_time(self):
        sb.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000)
        sb.record_run_status(metrics_dir=self.dir, succeeded=False, now=1_790_000_900)
        text = self._text()
        self.assertIn("db_binlog_ship_last_run_success 0\n", text)
        self.assertIn("db_binlog_ship_last_success_timestamp_seconds 1790000000\n", text)

    def test_a_failure_with_no_success_on_record_publishes_no_time(self):
        sb.record_run_status(metrics_dir=self.dir, succeeded=False, now=1_790_000_900)
        text = self._text()
        self.assertIn("db_binlog_ship_last_run_success 0\n", text)
        self.assertNotIn("last_success_timestamp_seconds", text)

    def test_a_corrupt_previous_file_is_treated_as_no_success(self):
        os.makedirs(self.dir)
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("db_binlog_ship_last_success_timestamp_seconds not-a-number\n")
        sb.record_run_status(metrics_dir=self.dir, succeeded=False, now=1_790_000_900)
        self.assertNotIn("last_success_timestamp_seconds", self._text())

    def test_no_metrics_dir_writes_nothing(self):
        for value in (None, ""):
            sb.record_run_status(metrics_dir=value, succeeded=True, now=1.0)
        self.assertFalse(os.path.exists(self.dir))

    def test_the_file_is_world_readable_and_leaves_no_temp_file(self):
        sb.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o644)
        self.assertEqual(os.listdir(self.dir), [sb.STATUS_FILENAME])

    def test_a_failed_replace_leaves_the_old_file_whole_and_no_temp_file(self):
        sb.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_000)
        before = self._text()
        with mock.patch("ship_binlogs.os.replace", side_effect=OSError("disk full")):
            sb.record_run_status(metrics_dir=self.dir, succeeded=True, now=1_790_000_900)
        self.assertEqual(self._text(), before)
        self.assertEqual(os.listdir(self.dir), [sb.STATUS_FILENAME])

    def test_no_failure_to_write_ever_raises(self):
        blocker = os.path.join(self.tmp, "file")
        with open(blocker, "w", encoding="utf-8") as handle:
            handle.write("x")
        self._assert_no_raise(metrics_dir=blocker)
        with mock.patch("ship_binlogs.tempfile.mkstemp", side_effect=RuntimeError("unexpected")):
            self._assert_no_raise(metrics_dir=self.dir)


class MainStatusTests(unittest.TestCase):
    ENV = {
        "DB_BINLOG_MYSQL_PWD": "pw",
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
        patcher = mock.patch.dict(os.environ, {**self.ENV, "DB_BINLOG_METRICS_DIR": self.dir})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _status(self):
        path = os.path.join(self.dir, sb.STATUS_FILENAME)
        self.assertTrue(os.path.exists(path), "no status file was written")
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def test_a_run_that_shipped_everything_publishes_success(self):
        with mock.patch.object(sb, "run_ship", return_value=["mysql-bin.000001"]):
            self.assertEqual(sb.main([]), 0)
        text = self._status()
        self.assertIn("db_binlog_ship_last_run_success 1\n", text)
        self.assertIn("db_binlog_ship_last_success_timestamp_seconds ", text)

    def test_a_run_with_nothing_pending_still_counts_as_a_success(self):
        with mock.patch.object(sb, "run_ship", return_value=[]):
            self.assertEqual(sb.main([]), 0)
        self.assertIn("db_binlog_ship_last_run_success 1\n", self._status())

    def test_a_failed_ship_publishes_failure_and_still_exits_1(self):
        with mock.patch.object(sb, "run_ship", side_effect=sb.ShipError("boom")):
            self.assertEqual(sb.main([]), 1)
        self.assertIn("db_binlog_ship_last_run_success 0\n", self._status())

    def test_a_missing_setting_publishes_failure(self):
        del os.environ["DB_BACKUP_BUCKET"]
        self.assertEqual(sb.main([]), 1)
        self.assertIn("db_binlog_ship_last_run_success 0\n", self._status())

    def test_an_unexpected_error_publishes_failure_and_still_propagates(self):
        with mock.patch.object(sb, "run_ship", side_effect=RuntimeError("unexpected")):
            with self.assertRaises(RuntimeError):
                sb.main([])
        self.assertIn("db_binlog_ship_last_run_success 0\n", self._status())

    def test_the_status_is_written_only_after_the_shipping_has_returned(self):
        order = []
        with mock.patch.object(sb, "run_ship", side_effect=lambda **kw: order.append("ship") or []), \
                mock.patch.object(sb, "record_run_status", side_effect=lambda **kw: order.append("status")):
            sb.main([])
        self.assertEqual(order, ["ship", "status"])

    def test_an_unwritable_metrics_dir_never_fails_the_shipping(self):
        os.environ["DB_BINLOG_METRICS_DIR"] = self.blocker
        with mock.patch.object(sb, "run_ship", return_value=[]):
            self.assertEqual(sb.main([]), 0)

    def test_a_broken_writer_never_fails_the_shipping(self):
        with mock.patch.object(sb, "run_ship", return_value=[]), \
                mock.patch("ship_binlogs.tempfile.mkstemp", side_effect=RuntimeError("unexpected")):
            try:
                code = sb.main([])
            except Exception as exc:  # the property under test is that nothing escapes
                self.fail(f"main raised {exc!r}")
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()

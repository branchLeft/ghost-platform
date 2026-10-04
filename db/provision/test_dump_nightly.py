#!/usr/bin/env python3
"""Unit tests for dump_nightly.py.

Every external command is faked -- no real mysqldump, age or network call --
so these assert the pipeline's ordering and failure handling: a failed stage
must stop the pipeline rather than uploading a partial or missing artifact,
and nothing plaintext must survive the run.
"""

import datetime
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import bounded_snapshot as bs
import dump_nightly as dn
from fake_mysql_clients import FakeMysqlClients

FAST = bs.Limits(hold_bound_seconds=1.5, max_attempts=3, backoff_seconds=(0.0,))

FAKE_SERVER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


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

    def test_writes_the_resume_comment_then_the_dump(self):
        self._dump()
        with open(self.out_path, "rb") as f:
            self.assertEqual(
                f.read(), b"-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000007', MASTER_LOG_POS=1234;\n-- dump content\n"
            )

    def test_dumps_every_database_without_source_data(self):
        self._dump()
        argv = self.fakes.starts("mysqldump")[0]["argv"]
        self.assertIn("--all-databases", argv)
        self.assertIn("--single-transaction", argv)
        self.assertNotIn("--source-data=2", argv)

    def test_locks_every_user_schema_and_never_flushes(self):
        self._dump()
        statements = self.fakes.statements()
        self.assertIn("LOCK TABLES `ghost_blog`.`users` READ, `ghost_shop`.`users` READ", statements)
        self.assertFalse([s for s in statements if "FLUSH" in s.upper()])

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
            b"AGE-ENCRYPTED:-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000007', MASTER_LOG_POS=1234;\n"
            b"-- dump content\n",
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

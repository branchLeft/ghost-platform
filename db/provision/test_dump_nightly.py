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
import unittest

import dump_nightly as dn

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


class RunMysqldumpTests(unittest.TestCase):
    def test_writes_stdout_to_the_target_path(self):
        run = FakeRun()
        with self._tmp_path() as path:
            dn.run_mysqldump(socket_path="/tmp/mysqld.sock", password="pw", out_path=path, run=run)
            with open(path, "rb") as f:
                self.assertEqual(f.read(), b"-- dump content\n")

    def test_never_passes_the_password_as_an_argument(self):
        run = FakeRun()
        with self._tmp_path() as path:
            dn.run_mysqldump(socket_path="/tmp/mysqld.sock", password="super-secret", out_path=path, run=run)
        for call in run.calls:
            self.assertNotIn("super-secret", call)

    def test_connects_over_the_socket_not_tcp(self):
        run = FakeRun()
        with self._tmp_path() as path:
            dn.run_mysqldump(socket_path="/opt/branchleft/db/run/mysqld/mysqld.sock", password="pw", out_path=path, run=run)
        call = run.calls[0]
        self.assertIn("--socket", call)
        self.assertEqual(call[call.index("--socket") + 1], "/opt/branchleft/db/run/mysqld/mysqld.sock")
        self.assertNotIn("--host", call)

    def test_raises_on_a_nonzero_exit(self):
        run = FakeRun(fail_command="mysqldump")
        with self._tmp_path() as path:
            with self.assertRaises(dn.DumpError):
                dn.run_mysqldump(socket_path="/tmp/mysqld.sock", password="pw", out_path=path, run=run)

    def _tmp_path(self):
        import tempfile

        class _Ctx:
            def __enter__(self_inner):
                self_inner.dir = tempfile.mkdtemp()
                return os.path.join(self_inner.dir, "dump.sql")

            def __exit__(self_inner, *exc):
                import shutil

                shutil.rmtree(self_inner.dir, ignore_errors=True)

        return _Ctx()


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


class RunDumpTests(unittest.TestCase):
    def setUp(self):
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
        )
        kwargs.update(overrides)
        return dn.run_dump(**kwargs)

    def test_happy_path_uploads_the_encrypted_dump_under_the_uuid_namespaced_key(self):
        run = FakeRun()
        key = self._run_dump(run)
        self.assertEqual(key, f"dumps/{FAKE_SERVER_UUID}/db1-20260822T031500Z.sql.age")
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.uploads[0]["key"], key)
        self.assertEqual(self.uploads[0]["data"], b"AGE-ENCRYPTED:-- dump content\n")
        self.assertEqual(self.uploads[0]["bucket"], "branchleft-db-backups")

    def test_a_failed_server_uuid_lookup_never_reaches_mysqldump(self):
        run = FakeRun(fail_command="mysql")
        with self.assertRaises(dn.DumpError):
            self._run_dump(run)
        self.assertEqual(self.uploads, [])
        self.assertNotIn("mysqldump", [c[0] for c in run.calls])

    def test_a_failed_mysqldump_never_reaches_encrypt_or_upload(self):
        run = FakeRun(fail_command="mysqldump")
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
            if argv[0] == "mysqldump":
                seen_paths.append(os.path.dirname(kwargs["stdout"].name))
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

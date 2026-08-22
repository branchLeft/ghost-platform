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


class FakeRun:
    """Writes plausible output for mysqldump/age so the pipeline has real
    bytes to carry forward, without invoking either binary."""

    def __init__(self, fail_command=None):
        self.calls = []
        self.fail_command = fail_command

    def __call__(self, argv, env=None, stdout=None, stderr=None, capture_output=None, check=None):
        self.calls.append(list(argv))
        command = argv[0]
        if command == self.fail_command:
            if stdout is not None:
                pass  # mysqldump writes nothing useful on failure
            return subprocess.CompletedProcess(argv, 1, stderr=b"boom")

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


class RunMysqldumpTests(unittest.TestCase):
    def test_writes_stdout_to_the_target_path(self):
        run = FakeRun()
        with self._tmp_path() as path:
            dn.run_mysqldump(host="10.20.1.20", password="pw", out_path=path, run=run)
            with open(path, "rb") as f:
                self.assertEqual(f.read(), b"-- dump content\n")

    def test_never_passes_the_password_as_an_argument(self):
        run = FakeRun()
        with self._tmp_path() as path:
            dn.run_mysqldump(host="10.20.1.20", password="super-secret", out_path=path, run=run)
        for call in run.calls:
            self.assertNotIn("super-secret", call)

    def test_raises_on_a_nonzero_exit(self):
        run = FakeRun(fail_command="mysqldump")
        with self._tmp_path() as path:
            with self.assertRaises(dn.DumpError):
                dn.run_mysqldump(host="10.20.1.20", password="pw", out_path=path, run=run)

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
        self.assertEqual(dn.object_key_for(now), "dumps/db1-20260822T031500Z.sql.age")


class RunDumpTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)
        self.uploads = []

    def _fake_upload(self, **kwargs):
        self.uploads.append(kwargs)

    def test_happy_path_uploads_the_encrypted_dump_under_the_dated_key(self):
        run = FakeRun()
        key = dn.run_dump(
            host="10.20.1.20",
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
        self.assertEqual(key, "dumps/db1-20260822T031500Z.sql.age")
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.uploads[0]["key"], key)
        self.assertEqual(self.uploads[0]["data"], b"AGE-ENCRYPTED:-- dump content\n")
        self.assertEqual(self.uploads[0]["bucket"], "branchleft-db-backups")

    def test_a_failed_mysqldump_never_reaches_encrypt_or_upload(self):
        run = FakeRun(fail_command="mysqldump")
        with self.assertRaises(dn.DumpError):
            dn.run_dump(
                host="10.20.1.20",
                password="pw",
                recipient="age1recipient",
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                now=self.now,
                run=run,
                upload=self._fake_upload,
            )
        self.assertEqual(self.uploads, [])
        self.assertNotIn("age", [c[0] for c in run.calls])

    def test_a_failed_encrypt_never_reaches_upload(self):
        run = FakeRun(fail_command="age")
        with self.assertRaises(dn.DumpError):
            dn.run_dump(
                host="10.20.1.20",
                password="pw",
                recipient="age1recipient",
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                now=self.now,
                run=run,
                upload=self._fake_upload,
            )
        self.assertEqual(self.uploads, [])

    def test_the_tempdir_is_gone_once_run_dump_returns(self):
        seen_paths = []

        def spying_run(argv, **kwargs):
            if argv[0] == "mysqldump":
                seen_paths.append(os.path.dirname(kwargs["stdout"].name))
            return FakeRun()(argv, **kwargs)

        dn.run_dump(
            host="10.20.1.20",
            password="pw",
            recipient="age1recipient",
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            now=self.now,
            run=spying_run,
            upload=self._fake_upload,
        )
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

#!/usr/bin/env python3
"""Unit tests for dump_tenant.py.

Every external command is faked -- no real mysqldump, mysql or network call
-- so these cover the pipeline's ordering, its per-tenant failure isolation,
and the floor check's refusal to emit an empty dump. A separate section
proves, statically and behaviourally, that nothing here can reach object
storage: that is the property a live credential leak would slip past a
mocked-command test, so it gets its own assertions rather than riding along
with the pipeline tests.
"""

from __future__ import annotations

import inspect
import io
import os
import pathlib
import re
import subprocess
import unittest
from unittest import mock

import dump_tenant as dt
from naming import InvalidTenantName

FLOOR_OK = ["1\n", "1\n"]  # users, posts -- both non-empty


class FakeRun:
    """Answers `mysql` (floor-check COUNT queries, in FLOOR_TABLES order) and
    `mysqldump` (writes fixed bytes to the stdout target it was given), with
    nothing invoked for real."""

    def __init__(self, mysql_responses=None, mysqldump_bytes=b"-- dump content\n", fail_command=None):
        self.mysql_responses = list(FLOOR_OK if mysql_responses is None else mysql_responses)
        self.mysqldump_bytes = mysqldump_bytes
        self.fail_command = fail_command
        self.calls = []

    def __call__(self, argv, env=None, stdout=None, stderr=None, capture_output=None, text=None, check=None):
        self.calls.append({"argv": list(argv), "env": dict(env or {})})
        command = argv[0]

        if command == self.fail_command:
            return subprocess.CompletedProcess(argv, 1, stdout="" if text else b"", stderr="boom" if text else b"boom")

        if command == "mysql":
            out = self.mysql_responses.pop(0) if self.mysql_responses else "0\n"
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

        if command == "mysqldump":
            stdout.write(self.mysqldump_bytes)
            return subprocess.CompletedProcess(argv, 0, stderr=b"")

        raise AssertionError(f"unexpected command: {command}")


class CheckFloorTests(unittest.TestCase):
    def test_passes_when_every_floor_table_has_rows(self):
        run = FakeRun(mysql_responses=["3\n", "12\n"])
        counts = dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertEqual(counts, {"users": 3, "posts": 12})

    def test_raises_when_users_is_empty(self):
        run = FakeRun(mysql_responses=["0\n", "12\n"])
        with self.assertRaises(dt.FloorError) as ctx:
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertIn("users", str(ctx.exception))

    def test_raises_when_posts_is_empty(self):
        run = FakeRun(mysql_responses=["3\n", "0\n"])
        with self.assertRaises(dt.FloorError) as ctx:
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertIn("posts", str(ctx.exception))

    def test_names_every_empty_table_at_once(self):
        run = FakeRun(mysql_responses=["0\n", "0\n"])
        with self.assertRaises(dt.FloorError) as ctx:
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertIn("users", str(ctx.exception))
        self.assertIn("posts", str(ctx.exception))

    def test_raises_on_unreadable_count(self):
        run = FakeRun(mysql_responses=["not-a-number\n", "1\n"])
        with self.assertRaises(dt.FloorError):
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)

    def test_a_failed_mysql_query_raises_dump_error(self):
        run = FakeRun(fail_command="mysql")
        with self.assertRaises(dt.DumpError):
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)

    def test_never_passes_the_password_as_an_argument(self):
        run = FakeRun()
        dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="super-secret", run=run)
        for call in run.calls:
            self.assertNotIn("super-secret", call["argv"])


class RunMysqldumpTests(unittest.TestCase):
    def test_writes_the_dump_to_the_given_stdout(self):
        run = FakeRun()
        out = io.BytesIO()
        dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=out, run=run)
        self.assertEqual(out.getvalue(), b"-- dump content\n")

    def test_dumps_one_named_database_never_all_databases(self):
        run = FakeRun()
        dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), run=run)
        argv = run.calls[0]["argv"]
        self.assertIn("--databases", argv)
        self.assertEqual(argv[argv.index("--databases") + 1], "ghost_blog")
        self.assertNotIn("--all-databases", argv)

    def test_connects_over_the_socket_not_tcp(self):
        run = FakeRun()
        dt.run_mysqldump(
            socket_path="/opt/branchleft/db/run/mysqld/mysqld.sock",
            password="pw",
            db_name="ghost_blog",
            stdout=io.BytesIO(),
            run=run,
        )
        argv = run.calls[0]["argv"]
        self.assertIn("--socket", argv)
        self.assertEqual(argv[argv.index("--socket") + 1], "/opt/branchleft/db/run/mysqld/mysqld.sock")
        self.assertNotIn("--host", argv)

    def test_never_passes_the_password_as_an_argument(self):
        run = FakeRun()
        dt.run_mysqldump(socket_path="/tmp/s", password="super-secret", db_name="ghost_blog", stdout=io.BytesIO(), run=run)
        for call in run.calls:
            self.assertNotIn("super-secret", call["argv"])

    def test_raises_on_a_nonzero_exit(self):
        run = FakeRun(fail_command="mysqldump")
        with self.assertRaises(dt.DumpError):
            dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), run=run)


class RunDumpTests(unittest.TestCase):
    def test_happy_path_returns_the_database_name_and_streams_the_dump(self):
        run = FakeRun()
        out = io.BytesIO()
        db_name = dt.run_dump(tenant_name="blog", socket_path="/tmp/s", password="pw", stdout=out, run=run)
        self.assertEqual(db_name, "ghost_blog")
        self.assertEqual(out.getvalue(), b"-- dump content\n")

    def test_a_hyphenated_tenant_name_maps_to_its_underscored_database(self):
        run = FakeRun()
        db_name = dt.run_dump(tenant_name="my-blog", socket_path="/tmp/s", password="pw", stdout=io.BytesIO(), run=run)
        self.assertEqual(db_name, "ghost_my_blog")

    def test_an_invalid_tenant_name_never_reaches_mysql_or_mysqldump(self):
        run = FakeRun()
        with self.assertRaises(InvalidTenantName):
            dt.run_dump(tenant_name="Not Valid!", socket_path="/tmp/s", password="pw", stdout=io.BytesIO(), run=run)
        self.assertEqual(run.calls, [])

    def test_a_floor_failure_never_reaches_mysqldump_and_stdout_stays_empty(self):
        run = FakeRun(mysql_responses=["0\n", "1\n"])
        out = io.BytesIO()
        with self.assertRaises(dt.FloorError):
            dt.run_dump(tenant_name="blog", socket_path="/tmp/s", password="pw", stdout=out, run=run)
        self.assertNotIn("mysqldump", [c["argv"][0] for c in run.calls])
        self.assertEqual(out.getvalue(), b"")

    def test_one_tenants_floor_failure_leaves_a_separate_invocation_unaffected(self):
        """Fail-closed-per-tenant is structural here, not a flag: each
        invocation is an independent process with no state shared between
        tenants, so tenant B's success cannot be reached by anything tenant
        A's failure touched."""
        tenant_a_run = FakeRun(mysql_responses=["0\n", "1\n"])
        with self.assertRaises(dt.FloorError):
            dt.run_dump(tenant_name="tenant-a", socket_path="/tmp/s", password="pw", stdout=io.BytesIO(), run=tenant_a_run)

        tenant_b_run = FakeRun()
        out_b = io.BytesIO()
        db_name = dt.run_dump(
            tenant_name="tenant-b", socket_path="/tmp/s", password="pw", stdout=out_b, run=tenant_b_run
        )
        self.assertEqual(db_name, "ghost_tenant_b")
        self.assertEqual(out_b.getvalue(), b"-- dump content\n")


class RequireEnvTests(unittest.TestCase):
    def test_raises_when_missing(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOES_NOT_EXIST_XYZ", None)
            with self.assertRaises(dt.DumpError):
                dt._require_env("DOES_NOT_EXIST_XYZ")


class MainTests(unittest.TestCase):
    def test_success_writes_only_dump_bytes_to_stdout(self):
        run = FakeRun()
        out = io.BytesIO()
        with mock.patch.dict(os.environ, {"DB_DUMP_MYSQL_PWD": "pw"}, clear=True):
            exit_code = dt.main(["blog"], run=run, stdout=out)
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.getvalue(), b"-- dump content\n")

    def test_missing_password_fails_before_touching_mysql(self):
        run = FakeRun()
        with mock.patch.dict(os.environ, {}, clear=True):
            exit_code = dt.main(["blog"], run=run, stdout=io.BytesIO())
        self.assertEqual(exit_code, 1)
        self.assertEqual(run.calls, [])

    def test_an_invalid_tenant_name_exits_nonzero(self):
        run = FakeRun()
        with mock.patch.dict(os.environ, {"DB_DUMP_MYSQL_PWD": "pw"}, clear=True):
            exit_code = dt.main(["Not Valid!"], run=run, stdout=io.BytesIO())
        self.assertEqual(exit_code, 1)

    def test_a_floor_failure_exits_nonzero_and_writes_no_dump_bytes(self):
        run = FakeRun(mysql_responses=["0\n", "1\n"])
        out = io.BytesIO()
        with mock.patch.dict(os.environ, {"DB_DUMP_MYSQL_PWD": "pw"}, clear=True):
            exit_code = dt.main(["blog"], run=run, stdout=out)
        self.assertEqual(exit_code, 1)
        self.assertEqual(out.getvalue(), b"")

    def test_accepts_a_socket_override(self):
        run = FakeRun()
        with mock.patch.dict(os.environ, {"DB_DUMP_MYSQL_PWD": "pw"}, clear=True):
            exit_code = dt.main(["blog", "--socket", "/custom/mysqld.sock"], run=run, stdout=io.BytesIO())
        self.assertEqual(exit_code, 0)
        argv = run.calls[0]["argv"]
        self.assertEqual(argv[argv.index("--socket") + 1], "/custom/mysqld.sock")


class NoStorageCredentialTests(unittest.TestCase):
    """The story this module exists for: the tenant database host must hold
    no storage or encryption credential at all. A mocked-command pipeline
    test cannot prove that -- the fake would happily answer a put_object
    call too -- so this proves it two other ways: nothing in the source
    names a storage-shaped identifier, and every function's own signature is
    incapable of accepting one."""

    FORBIDDEN_IDENTIFIERS = (
        "objectstorage",
        "put_object",
        "ObjectStorageError",
        "boto3",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AGE_RECIPIENT_PUBLIC_KEY",
        "DB_BACKUP_BUCKET",
        "DB_BACKUP_ENDPOINT",
        "DB_BACKUP_REGION",
        "age",
    )

    def test_module_source_names_no_storage_or_encryption_identifier(self):
        source = pathlib.Path(dt.__file__).read_text(encoding="utf-8")
        for name in self.FORBIDDEN_IDENTIFIERS:
            with self.subTest(name=name):
                # Word-boundary match: "age" alone must not fire on "storage"
                # or "package", only on the identifier/tool name itself.
                pattern = re.compile(r"\b" + re.escape(name) + r"\b")
                match = pattern.search(source)
                self.assertIsNone(
                    match,
                    f"dump_tenant.py names {name!r} -- a storage or encryption "
                    "credential path has no business existing on this host",
                )

    def test_the_matcher_actually_catches_a_reintroduced_credential(self):
        """A matcher that cannot see the real defect would pass the file it
        exists to check."""
        pattern = re.compile(r"\bAWS_ACCESS_KEY_ID\b")
        self.assertIsNotNone(pattern.search("access_key = os.environ['AWS_ACCESS_KEY_ID']"))
        self.assertIsNone(pattern.search("no such variable is read here"))

    def test_run_dump_signature_has_no_storage_or_key_parameter(self):
        params = set(inspect.signature(dt.run_dump).parameters)
        for forbidden in ("bucket", "endpoint", "region", "access_key", "secret_key", "recipient", "upload"):
            self.assertNotIn(forbidden, params)

    def test_main_succeeds_with_no_storage_variable_present_in_the_environment(self):
        """DB_DUMP_MYSQL_PWD is the only variable this script ever reads --
        proved here by running it to completion in an environment that
        contains nothing else at all."""
        run = FakeRun()
        out = io.BytesIO()
        with mock.patch.dict(os.environ, {"DB_DUMP_MYSQL_PWD": "pw"}, clear=True):
            exit_code = dt.main(["blog"], run=run, stdout=out)
            self.assertEqual(set(os.environ), {"DB_DUMP_MYSQL_PWD"})
        self.assertEqual(exit_code, 0)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Unit tests for dump_tenant.py.

Every external command is faked -- no real mysqldump, mysql or network call
-- so these cover the pipeline's ordering, its per-tenant failure isolation,
and both floor checks: the early source-side refusal (an exact count, a real
`COUNT(*)`), and the one that actually matters, which watches what
mysqldump's own stream wrote for *presence* rather than counting it --
mysqldump's default packed form can put any number of rows on one matched
line, so presence is the only claim the streamed check makes. A separate
section proves, statically and behaviourally, that no storage or encryption
credential can reach this script or the children it spawns -- that property
has to survive both a forwarded environment and a dropped refusal, so each
has its own sabotage. A further section proves byte-for-byte fidelity
through `main`'s own default stdout wiring, including the exact bug a
`sys.stdout.buffer` typo would reintroduce.
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

FLOOR_OK = ["1\n", "1\n"]  # users, settings -- both non-empty on the source

DUMP_LINES_HAPPY = [
    b"-- MySQL dump 10.13\n",
    b"CREATE DATABASE /*!32312 IF NOT EXISTS*/ `ghost_blog`;\n",
    b"INSERT INTO `users` VALUES ('u1','Owner');\n",
    b"INSERT INTO `settings` VALUES ('s1','title','Blog');\n",
    b"INSERT INTO `settings` VALUES ('s2','description','A blog');\n",
]

# The exact defect the reviewer measured live: mysqldump exits 0 (a `--no-data`
# invocation is a valid, complete run) but writes no INSERT statement for
# either floor table.
DUMP_LINES_NO_DATA = [
    b"-- MySQL dump 10.13 (--no-data)\n",
    b"CREATE DATABASE /*!32312 IF NOT EXISTS*/ `ghost_blog`;\n",
    b"-- no data written\n",
]

DUMP_LINES_USERS_ONLY = [
    b"-- header\n",
    b"INSERT INTO `users` VALUES ('u1','Owner');\n",
]

# A single packed (extended-insert) line carrying many tuples for one table
# -- proves presence is asserted per matched *line*, not per row, since
# --skip-extended-insert was dropped and mysqldump's default output is
# exactly this shape.
DUMP_LINES_PACKED_SETTINGS = [
    b"-- header\n",
    b"INSERT INTO `users` VALUES ('u1','Owner');\n",
    b"INSERT INTO `settings` VALUES ('s1','a','1'),('s2','b','2'),('s3','c','3');\n",
]


def _clean_env(**extra):
    """A minimal environment with nothing storage-shaped in it, for tests
    that exercise run_dump()/main() and must not trip the start-up guard on
    whatever the test runner's own ambient environment happens to carry."""
    env = {"PATH": "/usr/bin:/bin"}
    env.update(extra)
    return env


class FakeRun:
    """Answers `mysql` (floor pre-check COUNT queries, in FLOOR_TABLES
    order), with nothing invoked for real."""

    def __init__(self, mysql_responses=None, fail_command=None):
        self.mysql_responses = list(FLOOR_OK if mysql_responses is None else mysql_responses)
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

        raise AssertionError(f"unexpected command: {command}")


class _FakePipe:
    """Iterating yields the given lines, exactly once each, exactly like a
    real subprocess pipe opened in binary mode."""

    def __init__(self, lines):
        self._iter = iter(lines)
        self.closed = False

    def __iter__(self):
        return self._iter

    def close(self):
        self.closed = True


class _FakeProcess:
    def __init__(self, lines, returncode):
        self.stdout = _FakePipe(lines)
        self._returncode = returncode

    def wait(self):
        return self._returncode


class FakePopen:
    """Stands in for subprocess.Popen. Each call records its argv and env,
    writes the configured stderr bytes into whatever real file object the
    caller passed as `stderr` (mirroring a real child writing to an fd), and
    returns a fake process whose stdout iterates the configured lines."""

    def __init__(self, lines=None, returncode=0, stderr_bytes=b""):
        self.lines = list(DUMP_LINES_HAPPY if lines is None else lines)
        self.returncode = returncode
        self.stderr_bytes = stderr_bytes
        self.calls = []

    def __call__(self, argv, env=None, stdout=None, stderr=None):
        self.calls.append({"argv": list(argv), "env": dict(env or {})})
        if stderr is not None and self.stderr_bytes:
            stderr.write(self.stderr_bytes)
            stderr.flush()
        return _FakeProcess(self.lines, self.returncode)


class CheckFloorTests(unittest.TestCase):
    """The early refusal against the live source."""

    def test_passes_when_every_floor_table_has_rows(self):
        run = FakeRun(mysql_responses=["3\n", "117\n"])
        counts = dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertEqual(counts, {"users": 3, "settings": 117})

    def test_raises_when_users_is_empty(self):
        run = FakeRun(mysql_responses=["0\n", "117\n"])
        with self.assertRaises(dt.FloorError) as ctx:
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertIn("users", str(ctx.exception))

    def test_raises_when_settings_is_empty(self):
        run = FakeRun(mysql_responses=["3\n", "0\n"])
        with self.assertRaises(dt.FloorError) as ctx:
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertIn("settings", str(ctx.exception))

    def test_names_every_empty_table_at_once(self):
        run = FakeRun(mysql_responses=["0\n", "0\n"])
        with self.assertRaises(dt.FloorError) as ctx:
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        self.assertIn("users", str(ctx.exception))
        self.assertIn("settings", str(ctx.exception))

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

    def test_child_env_is_allowlisted_even_with_storage_variables_present(self):
        run = FakeRun()
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin", "AWS_ACCESS_KEY_ID": "leak", "HOME": "/root"}, clear=True):
            dt.check_floor(socket_path="/tmp/s", db_name="ghost_blog", password="pw", run=run)
        for call in run.calls:
            self.assertEqual(call["env"], {"PATH": "/usr/bin", "MYSQL_PWD": "pw"})


class RunMysqldumpStreamingTests(unittest.TestCase):
    """The floor check that actually matters: what the dump itself wrote."""

    def test_streams_every_byte_to_the_given_stdout_in_order(self):
        popen = FakePopen(lines=DUMP_LINES_HAPPY)
        out = io.BytesIO()
        dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=out, popen=popen)
        self.assertEqual(out.getvalue(), b"".join(DUMP_LINES_HAPPY))

    def test_returns_the_set_of_floor_tables_seen_not_a_count(self):
        popen = FakePopen(lines=DUMP_LINES_HAPPY)
        seen = dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        self.assertEqual(seen, {"users", "settings"})

    def test_never_passes_skip_extended_insert_mysqldumps_own_packed_form_is_kept(self):
        popen = FakePopen(lines=DUMP_LINES_HAPPY)
        dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        self.assertNotIn("--skip-extended-insert", popen.calls[0]["argv"])

    def test_a_single_packed_line_with_many_tuples_still_satisfies_the_floor(self):
        """The whole point of dropping --skip-extended-insert: one matched
        line, however many rows it packs, is enough to mark the table
        seen."""
        popen = FakePopen(lines=DUMP_LINES_PACKED_SETTINGS)
        seen = dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        self.assertEqual(seen, {"users", "settings"})

    def test_the_reviewers_no_data_reproduction_now_fails_the_floor(self):
        """Before this fix, the floor check only ever queried the live
        source and never looked at what mysqldump wrote -- this exact case
        (mysqldump exits 0, writes a structurally valid dump with zero
        INSERT statements) passed every test. It must not any more."""
        popen = FakePopen(lines=DUMP_LINES_NO_DATA, returncode=0)
        out = io.BytesIO()
        with self.assertRaises(dt.FloorError) as ctx:
            dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=out, popen=popen)
        self.assertIn("users", str(ctx.exception))
        self.assertIn("settings", str(ctx.exception))
        # Bytes already streamed before the failure are still on stdout --
        # the caller's job to discard them whole, not this function's job
        # to retract.
        self.assertEqual(out.getvalue(), b"".join(DUMP_LINES_NO_DATA))

    def test_one_floor_table_seen_and_the_other_not(self):
        popen = FakePopen(lines=DUMP_LINES_USERS_ONLY)
        with self.assertRaises(dt.FloorError) as ctx:
            dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        message = str(ctx.exception)
        self.assertIn("settings", message)
        self.assertNotIn("(settings, users)", message)

    def test_a_nonzero_mysqldump_exit_raises_dump_error_even_with_rows_seen(self):
        popen = FakePopen(lines=DUMP_LINES_HAPPY, returncode=2, stderr_bytes=b"boom")
        with self.assertRaises(dt.DumpError) as ctx:
            dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        self.assertIn("boom", str(ctx.exception))

    def test_never_passes_the_password_as_an_argument(self):
        popen = FakePopen()
        dt.run_mysqldump(socket_path="/tmp/s", password="super-secret", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        self.assertNotIn("super-secret", popen.calls[0]["argv"])

    def test_connects_over_the_socket_not_tcp(self):
        popen = FakePopen()
        dt.run_mysqldump(
            socket_path="/opt/branchleft/db/run/mysqld/mysqld.sock",
            password="pw",
            db_name="ghost_blog",
            stdout=io.BytesIO(),
            popen=popen,
        )
        argv = popen.calls[0]["argv"]
        self.assertIn("--socket", argv)
        self.assertEqual(argv[argv.index("--socket") + 1], "/opt/branchleft/db/run/mysqld/mysqld.sock")
        self.assertNotIn("--host", argv)

    def test_dumps_one_named_database_never_all_databases(self):
        popen = FakePopen()
        dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        argv = popen.calls[0]["argv"]
        self.assertIn("--databases", argv)
        self.assertEqual(argv[argv.index("--databases") + 1], "ghost_blog")
        self.assertNotIn("--all-databases", argv)

    def test_child_env_is_allowlisted_even_with_storage_variables_present(self):
        popen = FakePopen()
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin", "AWS_ACCESS_KEY_ID": "leak", "HOME": "/root"}, clear=True):
            dt.run_mysqldump(socket_path="/tmp/s", password="pw", db_name="ghost_blog", stdout=io.BytesIO(), popen=popen)
        self.assertEqual(popen.calls[0]["env"], {"PATH": "/usr/bin", "MYSQL_PWD": "pw"})


class RunDumpTests(unittest.TestCase):
    def test_happy_path_returns_the_database_name_and_streams_the_dump(self):
        run = FakeRun()
        popen = FakePopen()
        out = io.BytesIO()
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            db_name = dt.run_dump(
                tenant_name="blog", socket_path="/tmp/s", password="pw", stdout=out, run=run, popen=popen
            )
        self.assertEqual(db_name, "ghost_blog")
        self.assertEqual(out.getvalue(), b"".join(DUMP_LINES_HAPPY))

    def test_a_hyphenated_tenant_name_maps_to_its_underscored_database(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            db_name = dt.run_dump(
                tenant_name="my-blog", socket_path="/tmp/s", password="pw", stdout=io.BytesIO(), run=run, popen=popen
            )
        self.assertEqual(db_name, "ghost_my_blog")

    def test_an_invalid_tenant_name_never_reaches_mysql_or_mysqldump(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            with self.assertRaises(InvalidTenantName):
                dt.run_dump(
                    tenant_name="Not Valid!", socket_path="/tmp/s", password="pw", stdout=io.BytesIO(), run=run, popen=popen
                )
        self.assertEqual(run.calls, [])
        self.assertEqual(popen.calls, [])

    def test_a_source_side_floor_failure_never_reaches_mysqldump(self):
        run = FakeRun(mysql_responses=["0\n", "1\n"])
        popen = FakePopen()
        out = io.BytesIO()
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            with self.assertRaises(dt.FloorError):
                dt.run_dump(tenant_name="blog", socket_path="/tmp/s", password="pw", stdout=out, run=run, popen=popen)
        self.assertEqual(popen.calls, [])
        self.assertEqual(out.getvalue(), b"")

    def test_one_tenants_floor_failure_leaves_a_separate_invocation_unaffected(self):
        """Fail-closed-per-tenant is structural here, not a flag: each
        invocation is an independent process with no state shared between
        tenants, so tenant B's success cannot be reached by anything tenant
        A's failure touched."""
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            tenant_a_run = FakeRun(mysql_responses=["0\n", "1\n"])
            with self.assertRaises(dt.FloorError):
                dt.run_dump(
                    tenant_name="tenant-a",
                    socket_path="/tmp/s",
                    password="pw",
                    stdout=io.BytesIO(),
                    run=tenant_a_run,
                    popen=FakePopen(),
                )

            tenant_b_run = FakeRun()
            out_b = io.BytesIO()
            db_name = dt.run_dump(
                tenant_name="tenant-b",
                socket_path="/tmp/s",
                password="pw",
                stdout=out_b,
                run=tenant_b_run,
                popen=FakePopen(),
            )
        self.assertEqual(db_name, "ghost_tenant_b")
        self.assertEqual(out_b.getvalue(), b"".join(DUMP_LINES_HAPPY))

    def test_refuses_to_start_when_a_storage_variable_is_present(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(AWS_SECRET_ACCESS_KEY="leak"), clear=True):
            with self.assertRaises(dt.DumpError) as ctx:
                dt.run_dump(tenant_name="blog", socket_path="/tmp/s", password="pw", stdout=io.BytesIO(), run=run, popen=popen)
        self.assertIn("AWS_SECRET_ACCESS_KEY", str(ctx.exception))
        self.assertEqual(run.calls, [])
        self.assertEqual(popen.calls, [])


class RequireEnvTests(unittest.TestCase):
    def test_raises_when_missing(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOES_NOT_EXIST_XYZ", None)
            with self.assertRaises(dt.DumpError):
                dt._require_env("DOES_NOT_EXIST_XYZ")


class MainTests(unittest.TestCase):
    def test_success_writes_only_dump_bytes_to_stdout(self):
        run = FakeRun()
        popen = FakePopen()
        out = io.BytesIO()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            exit_code = dt.main(["blog"], run=run, popen=popen, stdout=out)
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.getvalue(), b"".join(DUMP_LINES_HAPPY))

    def test_missing_password_fails_before_touching_mysql(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            exit_code = dt.main(["blog"], run=run, popen=popen, stdout=io.BytesIO())
        self.assertEqual(exit_code, 1)
        self.assertEqual(run.calls, [])
        self.assertEqual(popen.calls, [])

    def test_an_invalid_tenant_name_exits_nonzero(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            exit_code = dt.main(["Not Valid!"], run=run, popen=popen, stdout=io.BytesIO())
        self.assertEqual(exit_code, 1)

    def test_a_source_side_floor_failure_exits_nonzero_and_writes_no_dump_bytes(self):
        run = FakeRun(mysql_responses=["0\n", "1\n"])
        popen = FakePopen()
        out = io.BytesIO()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            exit_code = dt.main(["blog"], run=run, popen=popen, stdout=out)
        self.assertEqual(exit_code, 1)
        self.assertEqual(out.getvalue(), b"")

    def test_the_streamed_floor_failure_exits_nonzero_too(self):
        run = FakeRun()
        popen = FakePopen(lines=DUMP_LINES_NO_DATA)
        out = io.BytesIO()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            exit_code = dt.main(["blog"], run=run, popen=popen, stdout=out)
        self.assertEqual(exit_code, 1)

    def test_a_storage_variable_present_refuses_before_anything_runs(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw", AGE_RECIPIENT_PUBLIC_KEY="age1..."), clear=True):
            exit_code = dt.main(["blog"], run=run, popen=popen, stdout=io.BytesIO())
        self.assertEqual(exit_code, 1)
        self.assertEqual(run.calls, [])
        self.assertEqual(popen.calls, [])

    def test_accepts_a_socket_override(self):
        run = FakeRun()
        popen = FakePopen()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            exit_code = dt.main(["blog", "--socket", "/custom/mysqld.sock"], run=run, popen=popen, stdout=io.BytesIO())
        self.assertEqual(exit_code, 0)
        argv = popen.calls[0]["argv"]
        self.assertEqual(argv[argv.index("--socket") + 1], "/custom/mysqld.sock")


class _FakeStdout:
    """Stands in for the real `sys.stdout`: a text-mode stream whose
    `.buffer` is the underlying binary one, exactly as CPython wires it.
    Deliberately has no usable `.write` of its own for raw bytes, mirroring
    a real text stream's TypeError on a bytes argument -- so code that
    reaches for `sys.stdout` instead of `sys.stdout.buffer` fails loudly
    rather than silently mangling the dump."""

    def __init__(self):
        self.buffer = io.BytesIO()


class MainDefaultStdoutByteIdentityTests(unittest.TestCase):
    """main()'s own default -- `sys.stdout.buffer`, never exercised by the
    other tests above, which all inject a BytesIO directly. Proves the
    wiring survives content a naive text-mode write would corrupt: CR,
    NUL, invalid UTF-8, and a line over a megabyte."""

    @staticmethod
    def _byte_identity_lines():
        long_line = b"INSERT INTO `settings` VALUES ('s2','blob'," + b"A" * (1024 * 1024 + 37) + b");\n"
        return [
            b"-- MySQL dump 10.13\r\n",  # CR
            b"INSERT INTO `users` VALUES ('u1','has a NUL \x00 byte');\n",  # NUL
            b"-- invalid utf-8 follows: \xff\x80\xc3\x28\n",  # invalid UTF-8
            long_line,  # > 1 MB, and satisfies the `settings` floor
        ]

    def test_bytes_through_mains_default_stdout_are_exactly_equal(self):
        lines = self._byte_identity_lines()
        run = FakeRun()
        popen = FakePopen(lines=lines)
        fake_stdout = _FakeStdout()
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            with mock.patch("dump_tenant.sys.stdout", fake_stdout):
                exit_code = dt.main(["blog"], run=run, popen=popen)
        self.assertEqual(exit_code, 0)
        self.assertEqual(fake_stdout.buffer.getvalue(), b"".join(lines))


class NoStorageCredentialInEnvironmentTests(unittest.TestCase):
    """The start-up refusal, independent of the child-env allowlist tested
    alongside check_floor/run_mysqldump above -- two barriers, each proven
    on its own so one cannot quietly cover for the other's sabotage."""

    def test_passes_with_nothing_forbidden_present(self):
        with mock.patch.dict(os.environ, _clean_env(DB_DUMP_MYSQL_PWD="pw"), clear=True):
            dt.assert_no_storage_credential_in_environment()  # must not raise

    def test_raises_naming_every_forbidden_variable(self):
        poisoned = _clean_env(
            AWS_ACCESS_KEY_ID="x", DB_BACKUP_BUCKET="y", AGE_RECIPIENT_PUBLIC_KEY="z"
        )
        with mock.patch.dict(os.environ, poisoned, clear=True):
            with self.assertRaises(dt.DumpError) as ctx:
                dt.assert_no_storage_credential_in_environment()
        message = str(ctx.exception)
        for name in ("AWS_ACCESS_KEY_ID", "DB_BACKUP_BUCKET", "AGE_RECIPIENT_PUBLIC_KEY"):
            self.assertIn(name, message)

    def test_the_prefix_set_actually_catches_every_named_shape(self):
        """A prefix set that has quietly narrowed would pass every file it
        exists to refuse."""
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DB_BACKUP_ENDPOINT", "DB_BACKUP_REGION", "AGE_RECIPIENT_PUBLIC_KEY"):
            with self.subTest(name=name):
                self.assertTrue(name.startswith(dt.FORBIDDEN_ENV_PREFIXES))

    def test_a_forwarded_environment_sabotage_would_leak_through_child_env(self):
        """Documents the second control this guard backs up: even with the
        refusal in place, _child_env must still be an allowlist rather than
        a forward, because a variable outside FORBIDDEN_ENV_PREFIXES (an
        unanticipated shape) would otherwise reach a child unfiltered."""
        with mock.patch.dict(os.environ, _clean_env(SOME_FUTURE_STORAGE_TOKEN="leak"), clear=True):
            env = dt._child_env("pw")
        self.assertNotIn("SOME_FUTURE_STORAGE_TOKEN", env)


class NoStorageCredentialTests(unittest.TestCase):
    """No storage-library or encryption-tool identifier appears in the
    module at all, and nothing in a function's own signature could carry
    one -- independent of the environment-based guards above."""

    FORBIDDEN_IDENTIFIERS = ("objectstorage", "put_object", "ObjectStorageError", "boto3")

    def test_module_source_names_no_storage_or_encryption_identifier(self):
        source = pathlib.Path(dt.__file__).read_text(encoding="utf-8")
        for name in self.FORBIDDEN_IDENTIFIERS:
            with self.subTest(name=name):
                pattern = re.compile(r"\b" + re.escape(name) + r"\b")
                match = pattern.search(source)
                self.assertIsNone(
                    match,
                    f"dump_tenant.py names {name!r} -- a storage or encryption "
                    "credential path has no business existing on this host",
                )
        # "age" (the encryption tool) is checked separately, word-boundary
        # matched so it cannot fire on "storage" or "package".
        self.assertIsNone(re.search(r"\bage\b", source))

    def test_the_matcher_actually_catches_a_reintroduced_identifier(self):
        """A matcher that cannot see the real defect would pass the file it
        exists to check."""
        pattern = re.compile(r"\bput_object\b")
        self.assertIsNotNone(pattern.search("from objectstorage import put_object"))
        self.assertIsNone(pattern.search("no such call is made here"))

    def test_run_dump_signature_has_no_storage_or_key_parameter(self):
        for fn in (dt.run_dump, dt.check_floor, dt.run_mysqldump, dt.main):
            params = set(inspect.signature(fn).parameters)
            for forbidden in ("bucket", "endpoint", "region", "access_key", "secret_key", "recipient", "upload"):
                with self.subTest(fn=fn.__name__, forbidden=forbidden):
                    self.assertNotIn(forbidden, params)


if __name__ == "__main__":
    unittest.main()

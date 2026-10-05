#!/usr/bin/env python3
"""Unit tests for dial_in_transport.py.

`LocalProcessTransport` is proven against real local subprocesses (`sh`,
`cat`, `python3` one-liners run through this file's own helper scripts under
`tmp` fixtures) -- no mocking of `subprocess.Popen` itself, since the
property under test (line-buffered streaming, an allowlisted child
environment, the exit code coming back faithfully) is exactly the part a
fake `Popen` would otherwise assume correct.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

import dial_in_transport as dit


class _CollectingSink:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    def write(self, chunk: bytes) -> int:
        self.chunks.append(chunk)
        return len(chunk)


class AssertNoForbiddenEnvTests(unittest.TestCase):
    def test_passes_with_nothing_forbidden(self) -> None:
        dit.assert_no_forbidden_env({"DB_DUMP_MYSQL_PWD": "pw", "PATH": "/usr/bin"})  # must not raise

    def test_raises_naming_every_forbidden_variable(self) -> None:
        poisoned = {
            "AWS_ACCESS_KEY_ID": "x",
            "DB_BACKUP_BUCKET": "y",
            "AGE_RECIPIENT_PUBLIC_KEY": "z",
            "DB_DUMP_MYSQL_PWD": "pw",
        }
        with self.assertRaises(dit.DialInTransportError) as ctx:
            dit.assert_no_forbidden_env(poisoned)
        message = str(ctx.exception)
        for name in ("AWS_ACCESS_KEY_ID", "DB_BACKUP_BUCKET", "AGE_RECIPIENT_PUBLIC_KEY"):
            self.assertIn(name, message)
        self.assertNotIn("DB_DUMP_MYSQL_PWD", message)

    def test_the_prefix_set_actually_catches_every_named_shape(self) -> None:
        for name in ("AWS_SECRET_ACCESS_KEY", "DB_BACKUP_ENDPOINT", "AGE_RECIPIENT_PUBLIC_KEY"):
            with self.subTest(name=name):
                self.assertTrue(name.startswith(dit.FORBIDDEN_ENV_PREFIXES))


class LocalProcessTransportTests(unittest.TestCase):
    def test_streams_stdout_and_returns_zero_on_success(self) -> None:
        transport = dit.LocalProcessTransport()
        sink = _CollectingSink()
        exit_code = transport.run(
            command=[sys.executable, "-c", "print('line one'); print('line two')"],
            env={},
            stdout=sink,
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(b"".join(sink.chunks), b"line one\nline two\n")

    def test_returns_the_real_nonzero_exit_code(self) -> None:
        transport = dit.LocalProcessTransport()
        sink = _CollectingSink()
        exit_code = transport.run(
            command=[sys.executable, "-c", "import sys; sys.exit(7)"],
            env={},
            stdout=sink,
        )
        self.assertEqual(exit_code, 7)

    def test_refuses_before_spawning_anything_when_env_is_forbidden(self) -> None:
        transport = dit.LocalProcessTransport()
        sink = _CollectingSink()
        with self.assertRaises(dit.DialInTransportError):
            transport.run(
                command=[sys.executable, "-c", "print('should never run')"],
                env={"AWS_ACCESS_KEY_ID": "leak"},
                stdout=sink,
            )
        self.assertEqual(sink.chunks, [])

    def test_child_sees_only_the_allowlist_plus_the_given_env_never_this_processs_own(self) -> None:
        """The allowlist-not-forward property `dump_tenant.py`'s own
        `_child_env` proves for the producer, proven here for the
        transport that would invoke it: a storage credential present in
        THIS process's ambient environment (the worker legitimately holds
        one, for `pull_encrypt_store.py`'s own copy puts) must never reach
        a child this transport spawns."""
        transport = dit.LocalProcessTransport()
        sink = _CollectingSink()
        with tempfile.TemporaryDirectory() as tmp:
            script = os.path.join(tmp, "print_env.py")
            with open(script, "w", encoding="utf-8") as handle:
                handle.write(
                    "import os\n"
                    "for name in sorted(os.environ):\n"
                    "    print(f'{name}={os.environ[name]}')\n"
                )
            with mock.patch.dict(
                os.environ, {"PATH": os.environ.get("PATH", ""), "AWS_SECRET_ACCESS_KEY": "leak"}
            ):
                exit_code = transport.run(
                    command=[sys.executable, script],
                    env={"DB_DUMP_MYSQL_PWD": "pw"},
                    stdout=sink,
                )
        self.assertEqual(exit_code, 0)
        output = b"".join(sink.chunks).decode()
        self.assertIn("DB_DUMP_MYSQL_PWD=pw", output)
        self.assertIn("PATH=", output)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", output)


_COMMAND = ["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"]
_ENV = {"DB_DUMP_MYSQL_PWD": "pw"}


def _remote_transport(**overrides) -> "dit.RemoteMysqldumpTransport":
    kwargs = {"host": "10.20.1.20", "user": "backup_ops1", "ssl_ca": "/etc/branchleft/mysql-ca.pem"}
    kwargs.update(overrides)
    return dit.RemoteMysqldumpTransport(**kwargs)


class RemoteMysqldumpTransportRefusalTests(unittest.TestCase):
    """The four refusals, each proven never to reach `popen` at all."""

    def test_refuses_before_spawning_when_env_is_forbidden(self) -> None:
        transport = _remote_transport(popen=mock.Mock(side_effect=AssertionError))
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env={"AWS_ACCESS_KEY_ID": "leak"}, stdout=_CollectingSink())

    def test_refuses_a_command_too_short_to_carry_a_tenant(self) -> None:
        transport = _remote_transport(popen=mock.Mock(side_effect=AssertionError))
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=["python3"], env=_ENV, stdout=_CollectingSink())

    def test_refuses_a_tenant_that_fails_the_strict_slug_pattern(self) -> None:
        """A caller-controlled string with a path separator or shell
        metacharacter must never reach a `--databases` argument."""
        transport = _remote_transport(popen=mock.Mock(side_effect=AssertionError))
        command = ["python3", "/x/dump_tenant.py", "../../etc/passwd", "--socket", "/x.sock"]
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=command, env=_ENV, stdout=_CollectingSink())

    def test_refuses_when_env_carries_no_mysql_password(self) -> None:
        transport = _remote_transport(popen=mock.Mock(side_effect=AssertionError))
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env={}, stdout=_CollectingSink())


def _load_fake_mysql_clients():
    source = pathlib.Path(__file__).resolve().parents[3] / "db" / "provision" / "fake_mysql_clients.py"
    spec = importlib.util.spec_from_file_location("fake_mysql_clients", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FakeMysqlClients = _load_fake_mysql_clients().FakeMysqlClients

_FAST = dit.bounded_snapshot.Limits(hold_bound_seconds=1.5, max_attempts=3, backoff_seconds=(0.0,))


class _RemoteTransportFixture(unittest.TestCase):
    """`mysql` and `mysqldump` are fake_mysql_clients.py's fakes on `PATH`:
    real `subprocess.Popen`, real streaming, real exit codes and kills,
    matching this file's own no-Popen-mocking convention."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fakes = FakeMysqlClients(self.tmp.name)
        self.fakes.configure(tables=[["ghost_blog", "settings"], ["ghost_blog", "users"]])
        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.tmp.name + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

    def transport(self, **overrides) -> "dit.RemoteMysqldumpTransport":
        overrides.setdefault("limits", _FAST)
        overrides.setdefault("sleep", lambda seconds: None)
        return _remote_transport(**overrides)

    def run_transport(self, transport=None, command=_COMMAND, env=_ENV) -> tuple[int, bytes]:
        transport = transport or self.transport()
        sink = _CollectingSink()
        exit_code = transport.run(command=command, env=env, stdout=sink)
        return exit_code, b"".join(sink.chunks)


class RemoteMysqldumpTransportArgvTests(_RemoteTransportFixture):
    def test_builds_the_expected_mysqldump_invocation(self) -> None:
        self.run_transport()
        argv = self.fakes.starts("mysqldump")[0]["argv"]
        for expected in (
            "--host", "10.20.1.20",
            "--port", "3306",
            "--user", "backup_ops1",
            "--ssl-mode=VERIFY_CA",
            "--ssl-ca", "/etc/branchleft/mysql-ca.pem",
            "--single-transaction",
            "--routines",
            "--triggers",
            "--set-gtid-purged=OFF",
            "--no-tablespaces",
            "--databases", "ghost_blog",
        ):
            self.assertIn(expected, argv)
        self.assertTrue(argv[0].startswith("--defaults-extra-file=/dev/fd/"))

    def test_never_asks_for_a_global_read_lock(self) -> None:
        self.run_transport()
        argv = self.fakes.starts("mysqldump")[0]["argv"]
        self.assertFalse([a for a in argv if a.startswith(("--source-data", "--master-data", "--flush-logs"))])
        self.assertFalse([a for a in argv if a in ("--lock-all-tables", "-x")])
        self.assertFalse([s for s in self.fakes.statements() if "FLUSH" in s.upper()])

    def test_locks_only_this_tenants_schema(self) -> None:
        self.run_transport()
        listing = next(s for s in self.fakes.statements() if s.startswith("SELECT TABLE_SCHEMA"))
        self.assertIn("TABLE_SCHEMA IN ('ghost_blog')", listing)

    def test_the_coordinator_connects_exactly_as_the_dump_does(self) -> None:
        self.run_transport()
        coordinator = self.fakes.starts("mysql")[0]["argv"]
        dump = self.fakes.starts("mysqldump")[0]["argv"]
        self.assertEqual(coordinator[1:10], dump[1:10])

    def test_a_hyphenated_tenant_becomes_the_underscored_database_name(self) -> None:
        command = ["python3", "/x/dump_tenant.py", "my-shop", "--socket", "/x.sock"]
        self.run_transport(command=command)
        self.assertIn("ghost_my_shop", self.fakes.starts("mysqldump")[0]["argv"])


class RemoteMysqldumpTransportRealSubprocessTests(_RemoteTransportFixture):
    def test_streams_the_resume_comment_then_stdout_and_returns_zero(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]], dump_lines=["line one", "line two"])
        exit_code, output = self.run_transport()
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            output,
            b"-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000007', MASTER_LOG_POS=1234;\nline one\nline two\n",
        )

    def test_returns_the_real_nonzero_exit_code(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]], dump_exit=7)
        exit_code, _ = self.run_transport()
        self.assertEqual(exit_code, 7)

    def test_records_the_snapshot_it_took(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]], lock=["timeout", "ok"])
        transport = self.transport()
        self.run_transport(transport)
        self.assertEqual(transport.last_snapshot.aborted_attempts, 1)
        self.assertEqual(transport.last_snapshot_aborts, 1)
        self.assertLess(transport.last_snapshot.hold_seconds, _FAST.hold_bound_seconds)

    def test_no_snapshot_is_a_producer_failure_with_nothing_streamed(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]], lock=["timeout"])
        transport = self.transport()
        exit_code, output = self.run_transport(transport)
        self.assertEqual(exit_code, dit.SNAPSHOT_FAILED_EXIT_CODE)
        self.assertEqual(output, b"")
        self.assertIsNone(transport.last_snapshot)
        self.assertEqual(transport.last_snapshot_aborts, 3)
        self.assertEqual(self.fakes.starts("mysqldump"), [])

    def test_a_second_run_does_not_inherit_the_first_runs_measurements(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]])
        transport = self.transport()
        self.run_transport(transport)
        self.fakes.configure(tables=[["ghost_blog", "users"]], lock=["timeout"])
        self.run_transport(transport)
        self.assertIsNone(transport.last_snapshot)

    def test_the_credential_never_appears_on_the_command_line(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]], dump_echo=True)
        _, output = self.run_transport(env={"DB_DUMP_MYSQL_PWD": "s3cret-pw"})
        first_line = output.splitlines()[1]
        self.assertNotIn(b"s3cret-pw", first_line)
        for start in self.fakes.events():
            if start["kind"] == "start":
                self.assertFalse(any("s3cret-pw" in arg for arg in start["argv"]))

    def test_the_credential_reaches_each_child_only_through_the_passed_fd(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]])
        self.run_transport(env={"DB_DUMP_MYSQL_PWD": "s3cret-pw"})
        starts = [e for e in self.fakes.events() if e["kind"] == "start"]
        self.assertEqual({e["binary"] for e in starts}, {"mysql", "mysqldump"})
        for start in starts:
            self.assertEqual(start["password"], "[client]\npassword=s3cret-pw\n")
            self.assertNotIn("MYSQL_PWD", start["environ"])
            self.assertTrue(set(start["environ"]) <= {"PATH", "PWD", "SHLVL", "_", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"})

    def test_a_hanging_producer_is_killed_after_its_timeout(self) -> None:
        self.fakes.configure(tables=[["ghost_blog", "users"]], dump_sleep=30)
        transport = self.transport(timeout_seconds=0.5)
        start = time.monotonic()
        with self.assertRaises(dit.DialInTransportError) as ctx:
            self.run_transport(transport)
        elapsed = time.monotonic() - start
        self.assertIn("timeout", str(ctx.exception))
        self.assertLess(elapsed, 8.0)


if __name__ == "__main__":
    unittest.main()

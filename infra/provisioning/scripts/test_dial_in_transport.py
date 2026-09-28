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

import os
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


class _FakeStdout:
    def __iter__(self):
        return iter(())

    def close(self) -> None:
        pass


class _FakeCompletedProcess:
    """A minimal stand-in for what `subprocess.Popen` returns, for the one
    test that only cares about the argv/env `RemoteMysqldumpTransport`
    builds -- everything else in this file runs a real subprocess, per
    this module's own no-Popen-mocking convention."""

    def __init__(self) -> None:
        self.stdout = _FakeStdout()
        self.stderr = mock.Mock(close=lambda: None)

    def wait(self) -> int:
        return 0

    def kill(self) -> None:
        pass


class RemoteMysqldumpTransportArgvTests(unittest.TestCase):
    def test_builds_the_expected_mysqldump_invocation(self) -> None:
        captured = {}

        def fake_popen(argv, *, env, stdout, stderr, start_new_session, pass_fds):
            captured["argv"] = argv
            captured["env"] = env
            captured["pass_fds"] = pass_fds
            return _FakeCompletedProcess()

        transport = _remote_transport(
            host="10.20.1.20", user="backup_ops1", ssl_ca="/etc/branchleft/mysql-ca.pem", port=3306, popen=fake_popen
        )
        transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())

        argv = captured["argv"]
        self.assertEqual(argv[0], "mysqldump")
        for expected in (
            "--host", "10.20.1.20",
            "--port", "3306",
            "--user", "backup_ops1",
            "--ssl-mode=VERIFY_CA",
            "--ssl-ca", "/etc/branchleft/mysql-ca.pem",
            "--single-transaction",
            "--source-data=2",
            "--routines",
            "--triggers",
            "--set-gtid-purged=OFF",
            "--databases", "ghost_blog",
        ):
            self.assertIn(expected, argv)
        # Never a plain --password/-p argument, never MYSQL_PWD in the
        # child's own environ -- see the class docstring. The credential
        # travels only through the one fd named in --defaults-extra-file,
        # which pass_fds is what keeps open across the exec.
        self.assertTrue(any(a.startswith("--defaults-extra-file=/dev/fd/") for a in argv))
        self.assertFalse(any("pw" in a for a in argv))
        self.assertNotIn("MYSQL_PWD", captured["env"])
        self.assertEqual(len(captured["pass_fds"]), 1)

    def test_a_hyphenated_tenant_becomes_the_underscored_database_name(self) -> None:
        captured = {}

        def fake_popen(argv, *, env, stdout, stderr, start_new_session, pass_fds):
            captured["argv"] = argv
            return _FakeCompletedProcess()

        transport = _remote_transport(popen=fake_popen)
        command = ["python3", "/x/dump_tenant.py", "my-shop", "--socket", "/x.sock"]
        transport.run(command=command, env=_ENV, stdout=_CollectingSink())
        self.assertIn("ghost_my_shop", captured["argv"])


class RemoteMysqldumpTransportRealSubprocessTests(unittest.TestCase):
    """`mysqldump` itself is faked as a tiny shell script on `PATH` --
    real `subprocess.Popen`, real streaming, real exit codes, matching
    this file's own no-Popen-mocking convention for everything but argv
    construction."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = self.tmp.name
        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

    def _write_fake_mysqldump(self, script: str) -> None:
        path = os.path.join(self.bin_dir, "mysqldump")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(script)
        os.chmod(path, 0o755)

    def test_streams_stdout_and_returns_zero_on_success(self) -> None:
        self._write_fake_mysqldump("#!/bin/sh\necho line one\necho line two\nexit 0\n")
        transport = _remote_transport()
        sink = _CollectingSink()
        exit_code = transport.run(command=_COMMAND, env=_ENV, stdout=sink)
        self.assertEqual(exit_code, 0)
        self.assertEqual(b"".join(sink.chunks), b"line one\nline two\n")

    def test_returns_the_real_nonzero_exit_code(self) -> None:
        self._write_fake_mysqldump("#!/bin/sh\nexit 7\n")
        transport = _remote_transport()
        exit_code = transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())
        self.assertEqual(exit_code, 7)

    def test_the_credential_never_appears_on_the_command_line(self) -> None:
        """The fake script echoes its own argv (never its env) -- if the
        password were ever passed as an argument rather than through the
        passed fd, it would show up in this output."""
        self._write_fake_mysqldump('#!/bin/sh\necho "$@"\nexit 0\n')
        transport = _remote_transport()
        sink = _CollectingSink()
        transport.run(command=_COMMAND, env={"DB_DUMP_MYSQL_PWD": "s3cret-pw"}, stdout=sink)
        self.assertNotIn(b"s3cret-pw", b"".join(sink.chunks))

    def test_the_credential_reaches_mysqldump_only_through_the_passed_fd(self) -> None:
        """The positive half of the property above: the password DOES
        reach the child -- by reading the exact file named in its own
        `--defaults-extra-file=` argument -- and it is absent from the
        child's own environ (`env` lists every inherited variable, one per
        line; MYSQL_PWD is never among them)."""
        self._write_fake_mysqldump(
            "#!/bin/sh\n"
            "for arg in \"$@\"; do\n"
            "  case \"$arg\" in\n"
            "    --defaults-extra-file=*) cat \"${arg#--defaults-extra-file=}\" ;;\n"
            "  esac\n"
            "done\n"
            "env\n"
            "exit 0\n"
        )
        transport = _remote_transport()
        sink = _CollectingSink()
        transport.run(command=_COMMAND, env={"DB_DUMP_MYSQL_PWD": "s3cret-pw"}, stdout=sink)
        output = b"".join(sink.chunks)
        self.assertIn(b"password=s3cret-pw", output)
        self.assertNotIn(b"MYSQL_PWD=", output)

    def test_a_hanging_producer_is_killed_after_its_timeout(self) -> None:
        self._write_fake_mysqldump("#!/bin/sh\nsleep 30\n")
        transport = _remote_transport(timeout_seconds=0.3)
        start = time.monotonic()
        with self.assertRaises(dit.DialInTransportError) as ctx:
            transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())
        elapsed = time.monotonic() - start
        self.assertIn("timeout", str(ctx.exception))
        # The bound a plain `process.kill()` (one pid, not the process
        # group) would blow: an orphaned `sleep 30` keeps the stdout pipe
        # open, and the read loop blocks for the full 30s instead of this
        # 0.3s timeout. Comfortably under 30s, comfortably over 0.3s.
        self.assertLess(elapsed, 5.0)


if __name__ == "__main__":
    unittest.main()

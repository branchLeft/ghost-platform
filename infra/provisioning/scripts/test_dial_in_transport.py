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


class UnwiredCollectorChannelTransportTests(unittest.TestCase):
    def test_raises_loudly_rather_than_silently_running_anything(self) -> None:
        transport = dit.UnwiredCollectorChannelTransport()
        with self.assertRaises(NotImplementedError) as ctx:
            transport.run(command=["true"], env={}, stdout=_CollectingSink())
        self.assertIn("no production DialInTransport is wired yet", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()

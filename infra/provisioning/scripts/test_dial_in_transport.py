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

import io
import json
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


_COMMAND = ["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"]
_ENV = {"DB_DUMP_MYSQL_PWD": "pw"}


class _FakeResponse:
    """Stands in for the object `urllib.request.urlopen` hands back on a
    2xx: a context manager whose iteration yields lines, with a `headers`
    mapping supporting `.get`, exactly the two things `DumpEndpointTransport`
    reads off it."""

    def __init__(self, lines: list[bytes], *, content_length: int | None = None) -> None:
        self._lines = lines
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False

    def __iter__(self):
        return iter(self._lines)


def _http_error(*, code: int, body: bytes) -> "dit.urllib.error.HTTPError":
    return dit.urllib.error.HTTPError("http://db1/dump/blog", code, "error", None, io.BytesIO(body))


class DumpEndpointTransportTests(unittest.TestCase):
    def test_refuses_before_dialling_when_env_is_forbidden(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420", bearer_token="t", urlopen=mock.Mock(side_effect=AssertionError)
        )
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env={"AWS_ACCESS_KEY_ID": "leak"}, stdout=_CollectingSink())

    def test_refuses_a_command_too_short_to_carry_a_tenant(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420", bearer_token="t", urlopen=mock.Mock(side_effect=AssertionError)
        )
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=["python3"], env=_ENV, stdout=_CollectingSink())

    def test_refuses_a_tenant_that_fails_the_strict_slug_pattern(self) -> None:
        """Independent of whatever validated (or failed to validate) the
        tenant name upstream -- see the class docstring's own
        two-independent-checks note. A caller-controlled string with a
        path separator or shell metacharacter must never reach a URL."""
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420", bearer_token="t", urlopen=mock.Mock(side_effect=AssertionError)
        )
        command = ["python3", "/x/dump_tenant.py", "../../etc/passwd", "--socket", "/x.sock"]
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=command, env=_ENV, stdout=_CollectingSink())

    def test_refuses_when_env_carries_no_mysql_password(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420", bearer_token="t", urlopen=mock.Mock(side_effect=AssertionError)
        )
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env={}, stdout=_CollectingSink())

    def test_sends_the_bearer_token_and_mysql_password_as_headers(self) -> None:
        captured = {}

        def fake_urlopen(request, timeout):
            captured["headers"] = dict(request.headers)
            captured["url"] = request.full_url
            return _FakeResponse([b"dump\n"], content_length=5)

        transport = dit.DumpEndpointTransport(base_url="http://db1:8420", bearer_token="s3cret", urlopen=fake_urlopen)
        transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())
        self.assertEqual(captured["headers"]["Authorization"], "Bearer s3cret")
        self.assertEqual(captured["headers"]["X-db-dump-mysql-pwd"], "pw")
        self.assertEqual(captured["url"], "http://db1:8420/dump/blog")

    def test_streams_every_line_into_stdout_and_returns_zero(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420",
            bearer_token="t",
            urlopen=lambda request, timeout: _FakeResponse([b"line one\n", b"line two\n"], content_length=18),
        )
        sink = _CollectingSink()
        exit_code = transport.run(command=_COMMAND, env=_ENV, stdout=sink)
        self.assertEqual(exit_code, 0)
        self.assertEqual(b"".join(sink.chunks), b"line one\nline two\n")

    def test_a_truncated_response_raises_rather_than_returning_zero(self) -> None:
        """The sabotage this test exists to catch: a response that stopped
        short of its own declared Content-Length must never be reported as
        a clean 0 exit -- see DumpEndpointTransport's own docstring."""
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420",
            bearer_token="t",
            # Server said 100 bytes were coming; only 8 actually arrived.
            urlopen=lambda request, timeout: _FakeResponse([b"line one"], content_length=100),
        )
        with self.assertRaises(dit.DialInTransportError) as ctx:
            transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())
        self.assertIn("truncated", str(ctx.exception))

    def test_connection_failure_raises(self) -> None:
        def fake_urlopen(request, timeout):
            raise dit.urllib.error.URLError("connection refused")

        transport = dit.DumpEndpointTransport(base_url="http://db1:8420", bearer_token="t", urlopen=fake_urlopen)
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())

    def test_401_raises_rather_than_returning_an_exit_code(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420",
            bearer_token="t",
            urlopen=mock.Mock(side_effect=_http_error(code=401, body=b'{"error": "Unauthorized"}')),
        )
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())

    def test_502_returns_the_producers_own_exit_code(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420",
            bearer_token="t",
            urlopen=mock.Mock(
                side_effect=_http_error(code=502, body=json.dumps({"error": "x", "exit_code": 1}).encode())
            ),
        )
        exit_code = transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())
        self.assertEqual(exit_code, 1)

    def test_502_with_an_unparseable_body_raises_rather_than_guessing_zero(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420",
            bearer_token="t",
            urlopen=mock.Mock(side_effect=_http_error(code=502, body=b"not json")),
        )
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())

    def test_an_unexpected_status_raises(self) -> None:
        transport = dit.DumpEndpointTransport(
            base_url="http://db1:8420",
            bearer_token="t",
            urlopen=mock.Mock(side_effect=_http_error(code=500, body=b"boom")),
        )
        with self.assertRaises(dit.DialInTransportError):
            transport.run(command=_COMMAND, env=_ENV, stdout=_CollectingSink())


if __name__ == "__main__":
    unittest.main()

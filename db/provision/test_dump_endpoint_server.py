#!/usr/bin/env python3
"""Unit tests for dump_endpoint_server.py: `handle_dump_request` against
plain arguments for every status code, then the real HTTP cycle end to end
against a real socket and a real `DumpEndpointTransport` client (loaded by
path -- see `_load_dial_in_transport` -- two independently-tested
directories, neither on the other's `sys.path`), with only `run_dump`
faked.
"""

from __future__ import annotations

import http.server
import importlib.util
import io
import json
import pathlib
import socket
import sys
import threading
import time
import unittest
from http import HTTPStatus

import dump_endpoint_server as des
from dump_tenant import DumpError
from naming import InvalidTenantName

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_DIAL_IN_TRANSPORT_SOURCE = _REPO_ROOT / "infra" / "provisioning" / "scripts" / "dial_in_transport.py"


def _load_dial_in_transport():
    spec = importlib.util.spec_from_file_location("dial_in_transport_for_test", _DIAL_IN_TRANSPORT_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Headers(dict):
    """A stand-in for `http.client.HTTPMessage` -- `handle_dump_request`
    only ever calls `.get(name)` on `headers`, case-sensitively here since
    every test constructs the exact header name it means to test."""


def _headers(*, token: str | None = None, mysql_pwd: str | None = None) -> _Headers:
    headers = _Headers()
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if mysql_pwd is not None:
        headers[des.MYSQL_PWD_HEADER] = mysql_pwd
    return headers


_TRUSTED_PEER = "10.20.1.50"


def _read_and_close(body) -> bytes:
    """`handle_dump_request`'s success path hands back an open file, never
    the whole dump materialised as `bytes` -- see `dump_endpoint_server.py`'s
    own module doc. Tests that only care about the bytes use this rather
    than repeating the read-then-close dance."""
    try:
        return body.read()
    finally:
        body.close()


def _fake_run_dump_ok(dump_bytes: bytes):
    def run_dump(*, tenant_name, socket_path, password, stdout):
        stdout.write(dump_bytes)
        return f"ghost_{tenant_name}"

    return run_dump


def _fake_run_dump_fails(message: str):
    def run_dump(*, tenant_name, socket_path, password, stdout):
        raise DumpError(message)

    return run_dump


class ConstantTimeTokenEqualsTests(unittest.TestCase):
    def test_matching_tokens(self) -> None:
        self.assertTrue(des.constant_time_token_equals("s3cret", "s3cret"))

    def test_mismatched_tokens_same_length(self) -> None:
        self.assertFalse(des.constant_time_token_equals("s3cret", "wr0ngg"))

    def test_mismatched_tokens_different_length(self) -> None:
        self.assertFalse(des.constant_time_token_equals("short", "a-lot-longer-token"))


class ParseBearerTokenTests(unittest.TestCase):
    def test_none_header(self) -> None:
        self.assertIsNone(des.parse_bearer_token(None))

    def test_missing_prefix(self) -> None:
        self.assertIsNone(des.parse_bearer_token("s3cret"))

    def test_strips_exactly_the_prefix(self) -> None:
        self.assertEqual(des.parse_bearer_token("Bearer s3cret"), "s3cret")


class HandleDumpRequestAuthTests(unittest.TestCase):
    def test_no_authorization_header_is_401(self) -> None:
        status, body, _ = self._call(headers=_headers(mysql_pwd="pw"))
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)

    def test_an_empty_configured_token_refuses_even_an_empty_presented_one(self) -> None:
        """`hmac.compare_digest("", "")` is `True` -- without this check,
        a server misconfigured with an empty `expected_token` would accept
        `Authorization: Bearer ` from anyone. Refused at the check itself,
        not only by `main()`'s own `_require_env`."""
        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="", mysql_pwd="pw"),
            expected_token="",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)

    def test_wrong_token_is_401(self) -> None:
        status, body, _ = self._call(headers=_headers(token="wrong", mysql_pwd="pw"))
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)

    def test_wrong_token_never_runs_the_producer(self) -> None:
        calls = []

        def run_dump(**kwargs):
            calls.append(kwargs)
            return "ghost_blog"

        des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="wrong", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=run_dump,
        )
        self.assertEqual(calls, [])

    def _call(self, *, headers):
        return des.handle_dump_request(
            path="/dump/blog",
            headers=headers,
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"dump bytes"),
        )


class HandleDumpRequestSourceTests(unittest.TestCase):
    """The second, independent layer beside the bearer token: a peer
    address that does not match `allowed_source` is refused, whatever the
    token says."""

    def test_mismatched_peer_is_403(self) -> None:
        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address="10.20.1.100",
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.FORBIDDEN)

    def test_mismatched_peer_never_runs_the_producer_even_with_the_right_token(self) -> None:
        calls = []

        def run_dump(**kwargs):
            calls.append(kwargs)
            return "ghost_blog"

        des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address="10.20.1.100",
            allowed_source=_TRUSTED_PEER,
            run_dump=run_dump,
        )
        self.assertEqual(calls, [])

    def test_matching_peer_is_not_refused_on_that_ground(self) -> None:
        status, body, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.OK)
        _read_and_close(body)


class HandleDumpRequestRoutingTests(unittest.TestCase):
    """Proves the 'never lets a caller name a path' property: nothing but
    a single, `/`-free tenant slug can ever reach `validate_tenant_name`,
    let alone `run_dump`."""

    def _call(self, path: str):
        return des.handle_dump_request(
            path=path,
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"dump bytes"),
        )

    def test_unknown_route_is_404(self) -> None:
        status, _, _ = self._call("/nope")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

    def test_path_traversal_attempt_is_never_a_200(self) -> None:
        for path in ("/dump/../../etc/passwd", "/dump/a/b", "/dump/", "/dump"):
            with self.subTest(path=path):
                status, _, _ = self._call(path)
                self.assertNotEqual(status, HTTPStatus.OK)

    def test_invalid_tenant_slug_is_400(self) -> None:
        for tenant in ("Blog", "blog;drop", "-blog", "blog_two", "b" * 40):
            with self.subTest(tenant=tenant):
                status, _, _ = self._call(f"/dump/{tenant}")
                self.assertEqual(status, HTTPStatus.BAD_REQUEST)

    def test_valid_tenant_slug_reaches_the_producer(self) -> None:
        status, body, _ = self._call("/dump/blog")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(_read_and_close(body), b"dump bytes")


class HandleDumpRequestMysqlPwdTests(unittest.TestCase):
    def test_missing_header_is_400(self) -> None:
        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)

    def test_empty_header_is_400(self) -> None:
        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd=""),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)

    def test_password_reaches_run_dump_and_only_run_dump(self) -> None:
        received = {}

        def run_dump(*, tenant_name, socket_path, password, stdout):
            received["password"] = password
            stdout.write(b"x")
            return "ghost_blog"

        status, body, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="s3cret-pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=run_dump,
        )
        _read_and_close(body)
        self.assertEqual(received["password"], "s3cret-pw")


class HandleDumpRequestProducerOutcomeTests(unittest.TestCase):
    def test_success_returns_200_with_the_full_dump_and_exact_content_type(self) -> None:
        status, body, headers = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"a real dump"),
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(_read_and_close(body), b"a real dump")
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_success_body_is_a_file_never_the_whole_dump_pre_read(self) -> None:
        """Pins the streaming property finding (4) exists to catch: the
        success path hands back an open, seekable file object, not a
        `bytes` blob already materialised in memory."""
        status, body, headers = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_ok(b"a real dump"),
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertFalse(isinstance(body, (bytes, bytearray)))
        self.assertTrue(hasattr(body, "read"))
        self.assertEqual(headers["Content-Length"], "11")
        _read_and_close(body)

    def test_producer_failure_is_502_with_a_parseable_exit_code_never_the_plaintext(self) -> None:
        status, body, headers = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=_fake_run_dump_fails("floor table empty"),
        )
        self.assertEqual(status, HTTPStatus.BAD_GATEWAY)
        payload = json.loads(body)
        self.assertEqual(payload["exit_code"], 1)
        self.assertNotIn("dump bytes", body.decode())

    def test_producer_raising_invalid_tenant_name_is_400_not_500(self) -> None:
        def run_dump(**kwargs):
            raise InvalidTenantName("bad")

        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            peer_address=_TRUSTED_PEER,
            allowed_source=_TRUSTED_PEER,
            run_dump=run_dump,
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)


class _EphemeralDumpEndpoint:
    """Starts `DumpEndpointHandler` on a real loopback socket, ephemeral
    port, in a background thread -- `HTTPServer`, single-threaded, the same
    class `main()` constructs. `run_dump` is faked at the class-attribute
    seam `DumpEndpointHandler.run_dump` exists for; nothing else about the
    request/response path is faked."""

    def __init__(
        self, *, token: str, run_dump, allowed_source: str = "127.0.0.1", timeout: float | None = None
    ) -> None:
        attrs = {"expected_token": token, "allowed_source": allowed_source, "run_dump": staticmethod(run_dump)}
        if timeout is not None:
            attrs["timeout"] = timeout
        handler = type("TestDumpEndpointHandler", (des.DumpEndpointHandler,), attrs)
        self._server = http.server.HTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server_address
        return f"http://{host}:{port}"

    @property
    def server_address(self) -> tuple[str, int]:
        return self._server.server_address

    def __enter__(self) -> "_EphemeralDumpEndpoint":
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self._server.shutdown()
        self._thread.join(timeout=5)
        self._server.server_close()


class DumpEndpointTransportEndToEndTests(unittest.TestCase):
    """The real HTTP request/response cycle, both directions: a real
    `DumpEndpointTransport` client against a real `DumpEndpointHandler`
    server on a real socket, exactly as `backup_worker.py` wires them once
    deployed -- only `run_dump` (a real MySQL socket) and the process
    boundary itself are out of scope for a unit test."""

    def setUp(self) -> None:
        self.dit = _load_dial_in_transport()

    def _sink(self) -> io.BytesIO:
        return io.BytesIO()

    def test_a_successful_dump_round_trips_byte_for_byte(self) -> None:
        with _EphemeralDumpEndpoint(token="right-token", run_dump=_fake_run_dump_ok(b"line one\nline two\n")) as ep:
            transport = self.dit.DumpEndpointTransport(base_url=ep.base_url, bearer_token="right-token")
            sink = self._sink()
            exit_code = transport.run(
                command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                env={"DB_DUMP_MYSQL_PWD": "pw"},
                stdout=sink,
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(sink.getvalue(), b"line one\nline two\n")

    def test_wrong_bearer_token_raises_rather_than_returning_zero(self) -> None:
        with _EphemeralDumpEndpoint(token="right-token", run_dump=_fake_run_dump_ok(b"x")) as ep:
            transport = self.dit.DumpEndpointTransport(base_url=ep.base_url, bearer_token="wrong-token")
            with self.assertRaises(self.dit.DialInTransportError):
                transport.run(
                    command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                    env={"DB_DUMP_MYSQL_PWD": "pw"},
                    stdout=self._sink(),
                )

    def test_producer_failure_comes_back_as_the_real_exit_code_not_zero(self) -> None:
        with _EphemeralDumpEndpoint(
            token="right-token", run_dump=_fake_run_dump_fails("floor table empty")
        ) as ep:
            transport = self.dit.DumpEndpointTransport(base_url=ep.base_url, bearer_token="right-token")
            sink = self._sink()
            exit_code = transport.run(
                command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                env={"DB_DUMP_MYSQL_PWD": "pw"},
                stdout=sink,
            )
        self.assertEqual(exit_code, 1)
        self.assertEqual(sink.getvalue(), b"")

    def test_a_dump_larger_than_one_chunk_still_round_trips_exactly(self) -> None:
        """Pins finding (4): the server streams from its temp file in
        `_CHUNK_SIZE`-sized pieces rather than holding the whole dump in
        memory. A dump spanning several chunks is the shape that would
        expose a chunking bug (an off-by-one at a chunk boundary, a short
        write) that a single-chunk dump could not."""
        big_dump = b"".join(f"line {i:07d}\n".encode() for i in range(200_000))  # ~2.6 MiB, several chunks
        self.assertGreater(len(big_dump), des._CHUNK_SIZE)
        with _EphemeralDumpEndpoint(token="right-token", run_dump=_fake_run_dump_ok(big_dump)) as ep:
            transport = self.dit.DumpEndpointTransport(base_url=ep.base_url, bearer_token="right-token")
            sink = self._sink()
            exit_code = transport.run(
                command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                env={"DB_DUMP_MYSQL_PWD": "pw"},
                stdout=sink,
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(sink.getvalue(), big_dump)

    def test_wrong_source_address_is_refused_over_a_real_socket(self) -> None:
        """`DumpEndpointTransport` always dials from 127.0.0.1 in this
        test process, so pointing `allowed_source` at a different address
        proves the check fires on a real connection's real peer address,
        not only on a hand-built `peer_address` string."""
        with _EphemeralDumpEndpoint(
            token="right-token", run_dump=_fake_run_dump_ok(b"x"), allowed_source="10.20.1.999"
        ) as ep:
            transport = self.dit.DumpEndpointTransport(base_url=ep.base_url, bearer_token="right-token")
            with self.assertRaises(self.dit.DialInTransportError):
                transport.run(
                    command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                    env={"DB_DUMP_MYSQL_PWD": "pw"},
                    stdout=self._sink(),
                )


class StalledConnectionTests(unittest.TestCase):
    """Finding (5): one idle peer must not hold the server's single thread
    forever. A short `timeout` and a connection that sends nothing prove
    the server recovers, by proving a second, well-formed request still
    gets answered promptly afterward -- the thing that would actually be
    true of a live backup run if this control were missing is every OTHER
    tenant's dump also failing that night."""

    def test_an_idle_connection_does_not_block_the_next_request(self) -> None:
        with _EphemeralDumpEndpoint(
            token="right-token", run_dump=_fake_run_dump_ok(b"x"), timeout=0.3
        ) as ep:
            host, port = ep.server_address
            stalled = socket.create_connection((host, port), timeout=5)
            try:
                # Opens the connection and sends nothing -- exactly what an
                # unauthenticated peer probing this port would do.
                start = time.monotonic()
                dit = _load_dial_in_transport()
                transport = dit.DumpEndpointTransport(base_url=ep.base_url, bearer_token="right-token")
                exit_code = transport.run(
                    command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                    env={"DB_DUMP_MYSQL_PWD": "pw"},
                    stdout=io.BytesIO(),
                )
                elapsed = time.monotonic() - start
            finally:
                stalled.close()
        self.assertEqual(exit_code, 0)
        # Well under the stalled connection's own 0.3s timeout plus slack --
        # the second request was answered on its own merits, not after
        # waiting for the first one to time out.
        self.assertLess(elapsed, 2.0)


if __name__ == "__main__":
    unittest.main()

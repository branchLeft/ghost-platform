#!/usr/bin/env python3
"""Unit tests for dump_endpoint_server.py.

`handle_dump_request` is proven directly against plain arguments (no real
socket) for every status-code path; a second section proves the real HTTP
request/response cycle end to end, against a real `HTTPServer` on a real
loopback socket and a real `DumpEndpointTransport` client
(`infra/provisioning/scripts/dial_in_transport.py`, loaded by path -- see
`_load_dial_in_transport` -- since the two directories are independently
tested and neither is on the other's `sys.path` by convention), with only
`run_dump` faked. That combination is what proves the wire contract itself
(headers, status codes, `Content-Length`) rather than only the pure
function underneath it.
"""

from __future__ import annotations

import http.server
import importlib.util
import io
import json
import pathlib
import sys
import threading
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
            run_dump=run_dump,
        )
        self.assertEqual(calls, [])

    def _call(self, *, headers):
        return des.handle_dump_request(
            path="/dump/blog",
            headers=headers,
            expected_token="right",
            run_dump=_fake_run_dump_ok(b"dump bytes"),
        )


class HandleDumpRequestRoutingTests(unittest.TestCase):
    """Proves the 'never lets a caller name a path' property: nothing but
    a single, `/`-free tenant slug can ever reach `validate_tenant_name`,
    let alone `run_dump`."""

    def _call(self, path: str):
        return des.handle_dump_request(
            path=path,
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
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
        self.assertEqual(body, b"dump bytes")


class HandleDumpRequestMysqlPwdTests(unittest.TestCase):
    def test_missing_header_is_400(self) -> None:
        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right"),
            expected_token="right",
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)

    def test_empty_header_is_400(self) -> None:
        status, _, _ = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd=""),
            expected_token="right",
            run_dump=_fake_run_dump_ok(b"x"),
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)

    def test_password_reaches_run_dump_and_only_run_dump(self) -> None:
        received = {}

        def run_dump(*, tenant_name, socket_path, password, stdout):
            received["password"] = password
            stdout.write(b"x")
            return "ghost_blog"

        des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="s3cret-pw"),
            expected_token="right",
            run_dump=run_dump,
        )
        self.assertEqual(received["password"], "s3cret-pw")


class HandleDumpRequestProducerOutcomeTests(unittest.TestCase):
    def test_success_returns_200_with_the_full_dump_and_exact_content_type(self) -> None:
        status, body, headers = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
            run_dump=_fake_run_dump_ok(b"a real dump"),
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"a real dump")
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_producer_failure_is_502_with_a_parseable_exit_code_never_the_plaintext(self) -> None:
        status, body, headers = des.handle_dump_request(
            path="/dump/blog",
            headers=_headers(token="right", mysql_pwd="pw"),
            expected_token="right",
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
            run_dump=run_dump,
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)


class _EphemeralDumpEndpoint:
    """Starts `DumpEndpointHandler` on a real loopback socket, ephemeral
    port, in a background thread -- `HTTPServer`, single-threaded, the same
    class `main()` constructs. `run_dump` is faked at the class-attribute
    seam `DumpEndpointHandler.run_dump` exists for; nothing else about the
    request/response path is faked."""

    def __init__(self, *, token: str, run_dump) -> None:
        handler = type(
            "TestDumpEndpointHandler",
            (des.DumpEndpointHandler,),
            {"expected_token": token, "run_dump": staticmethod(run_dump)},
        )
        self._server = http.server.HTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address
        return f"http://{host}:{port}"

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


if __name__ == "__main__":
    unittest.main()

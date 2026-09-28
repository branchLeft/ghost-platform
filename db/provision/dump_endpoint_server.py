#!/usr/bin/env python3
"""The tenant database host's dial-in surface: `GET /dump/<tenant>`,
answered, never dialled out from. Design and rationale: `dump-endpoint.md`,
this module's colocated doc.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import sys
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import BinaryIO

from dump_tenant import DEFAULT_SOCKET, DumpError, run_dump
from naming import InvalidTenantName, validate_tenant_name

BEARER_PREFIX = "Bearer "
MYSQL_PWD_HEADER = "X-Db-Dump-Mysql-Pwd"

# How much of one tenant's dump this process ever holds in memory at once
# while streaming a 200 response -- 1 MiB, well below what would trouble
# this host's memory even alongside mysqld's own footprint.
_CHUNK_SIZE = 1024 * 1024

# Matches exactly one path segment: `/dump/<tenant>`, nothing before or
# after it. A tenant name can never itself contain `/` (naming.py's own
# pattern is `[a-z0-9-]` only), so this regex alone is what stops a request
# like `/dump/../../etc/passwd` or `/dump/a/b` from ever reaching
# `validate_tenant_name` with anything but a single, path-separator-free
# token -- the strict tenant-name check below is the second, independent
# barrier, not the only one.
_DUMP_PATH = re.compile(r"\A/dump/([^/]+)\Z")


class DumpEndpointError(Exception):
    """Raised for a request this server refuses before ever invoking
    `run_dump` -- distinct from `DumpError`, which is the producer's own
    ordinary failure and is reported as a 502, not raised to the caller of
    `handle_dump_request`."""

    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_bearer_token(header: str | None) -> str | None:
    if not header or not header.startswith(BEARER_PREFIX):
        return None
    return header[len(BEARER_PREFIX) :]


def constant_time_token_equals(presented: str, expected: str) -> bool:
    """`hmac.compare_digest` rather than `==`: Python's own docs name this
    function specifically for comparing a caller-supplied secret against a
    known value in constant time, which is exactly this call. It is the
    equal-length case that a naive comparison should still get right by
    accident most of the time -- the property this function actually adds
    is that a *wrong* token of the *same or different* length takes the
    same time as a correct one, so response latency across many attempts
    cannot narrow down the real token character by character."""
    return hmac.compare_digest(presented, expected)


def _require_bearer_token(headers, expected_token: str) -> None:
    # Refuses closed on an empty expected_token itself, not only on the
    # caller side (main()'s _require_env): compare_digest("", "") is True,
    # and an empty Authorization value would otherwise satisfy it.
    if not expected_token:
        raise DumpEndpointError(HTTPStatus.UNAUTHORIZED, "Unauthorized")
    presented = parse_bearer_token(headers.get("Authorization"))
    if presented is None or not constant_time_token_equals(presented, expected_token):
        raise DumpEndpointError(HTTPStatus.UNAUTHORIZED, "Unauthorized")


def _require_allowed_source(peer_address: str, allowed_source: str) -> None:
    """A second, independent layer beside the bearer token -- not a
    replacement for nftables (`db/provision/dump-endpoint.md`'s handover
    covers installing that), but a check this process makes for itself
    regardless of whether the host firewall is configured yet. The
    allowed peer is a required, explicit value: which host in org/control
    ultimately runs the backup worker is an operational decision, not
    this module's to assume."""
    if peer_address != allowed_source:
        raise DumpEndpointError(HTTPStatus.FORBIDDEN, "Forbidden")


def _tenant_from_path(path: str) -> str:
    """Extracts the one path segment this server ever reads, and only that
    segment -- see `_DUMP_PATH`'s own comment for why a `/`-carrying path
    can never reach this function at all. Independently re-validated by
    `validate_tenant_name` in `handle_dump_request` below: this function's
    job is only to say the request *shape* matched one known route, never
    that the value inside it is safe to use."""
    match = _DUMP_PATH.match(path)
    if not match:
        raise DumpEndpointError(HTTPStatus.NOT_FOUND, "Not Found")
    return match.group(1)


def handle_dump_request(
    *,
    path: str,
    headers,
    expected_token: str,
    peer_address: str,
    allowed_source: str,
    socket_path: str = DEFAULT_SOCKET,
    run_dump=run_dump,
) -> tuple[HTTPStatus, bytes | BinaryIO, dict[str, str]]:
    """This server's request logic, independent of `BaseHTTPRequestHandler`
    so a test drives it with plain arguments, no socket. Always returns
    `(status, body, extra_headers)` -- `DumpEndpointError` is caught here,
    never left for a caller to handle. `body` is the complete dump on a
    200, a JSON error object on every other status; `extra_headers` never
    includes `Content-Length` (the caller derives that from `len(body)`).
    """
    try:
        return _handle_dump_request(
            path=path,
            headers=headers,
            expected_token=expected_token,
            peer_address=peer_address,
            allowed_source=allowed_source,
            socket_path=socket_path,
            run_dump=run_dump,
        )
    except DumpEndpointError as exc:
        return exc.status, json.dumps({"error": exc.message}).encode(), {"Content-Type": "application/json"}


def _handle_dump_request(
    *,
    path: str,
    headers,
    expected_token: str,
    peer_address: str,
    allowed_source: str,
    socket_path: str,
    run_dump,
) -> tuple[HTTPStatus, bytes | BinaryIO, dict[str, str]]:
    """The happy-path/refusal logic -- raises `DumpEndpointError` for every
    refusal, `handle_dump_request` above is the one place that turns it
    into a wire response."""
    _require_allowed_source(peer_address, allowed_source)
    _require_bearer_token(headers, expected_token)
    tenant = _tenant_from_path(path)

    try:
        validate_tenant_name(tenant)
    except InvalidTenantName as exc:
        raise DumpEndpointError(HTTPStatus.BAD_REQUEST, str(exc)) from None

    mysql_pwd = headers.get(MYSQL_PWD_HEADER)
    if not mysql_pwd:
        raise DumpEndpointError(HTTPStatus.BAD_REQUEST, f"{MYSQL_PWD_HEADER} must be set and non-empty")

    # An anonymous temp file, never read whole into memory: `do_GET` streams
    # it in chunks (see `_CHUNK_SIZE`) and closes it once sent. Left open on
    # a successful return -- the `finally` below only closes it for a path
    # that does NOT hand it back to the caller, so ownership always ends up
    # with exactly one side.
    dump_file = tempfile.TemporaryFile(prefix="dump-endpoint-", suffix=".sql")
    handed_off = False
    try:
        try:
            run_dump(
                tenant_name=tenant,
                socket_path=socket_path,
                password=mysql_pwd,
                stdout=dump_file,
            )
        except InvalidTenantName as exc:
            # Reachable in principle if run_dump's own check ever diverges
            # from the one above -- reported the same way, not trusted to
            # be unreachable.
            raise DumpEndpointError(HTTPStatus.BAD_REQUEST, str(exc)) from None
        except DumpError as exc:
            return (
                HTTPStatus.BAD_GATEWAY,
                json.dumps({"error": str(exc), "exit_code": 1}).encode(),
                {"Content-Type": "application/json"},
            )

        size = dump_file.tell()
        dump_file.seek(0)
        handed_off = True
        return (
            HTTPStatus.OK,
            dump_file,
            {"Content-Type": "application/octet-stream", "Content-Length": str(size)},
        )
    finally:
        if not handed_off:
            dump_file.close()


class DumpEndpointHandler(BaseHTTPRequestHandler):
    """Thin adapter onto `handle_dump_request` -- see that function's own
    docstring for the actual request logic. `expected_token` and
    `socket_path` are read from the class attributes `main()` sets on a
    per-process subclass, the same pattern `http.server`'s own
    `test()` helper uses, since `HTTPServer` constructs a handler instance
    per request with no constructor hook of its own to pass extra state
    through."""

    expected_token: str = ""
    allowed_source: str = "127.0.0.1"
    socket_path: str = DEFAULT_SOCKET
    # Overridable per test subclass, the same way expected_token and
    # socket_path are -- lets a test point this handler at a fake producer
    # and prove the real HTTP request/response cycle (headers, status
    # codes, Content-Length) without a real MySQL socket, without mocking
    # anything inside handle_dump_request itself.
    run_dump = staticmethod(run_dump)
    server_version = "branchleft-dump-endpoint/1"
    # Read AND write timeout on the request socket -- an idle peer (opened
    # a connection, sent nothing) must not hold the one thread this server
    # ever has forever. See `main()` for the real value.
    timeout = 60

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        # Never logs a header (the bearer token and the MySQL password both
        # arrive as headers) -- only the request line and status, the same
        # information BaseHTTPRequestHandler's default logs, routed through
        # stderr for journald rather than reformatted.
        sys.stderr.write("%s - - %s\n" % (self.address_string(), format % args))

    def do_GET(self) -> None:  # noqa: N802 - stdlib method name
        status, body, extra_headers = handle_dump_request(
            path=self.path,
            headers=self.headers,
            expected_token=self.expected_token,
            peer_address=self.client_address[0],
            allowed_source=self.allowed_source,
            socket_path=self.socket_path,
            run_dump=self.run_dump,
        )
        self.send_response(status)
        for name, value in extra_headers.items():
            self.send_header(name, value)
        if "Content-Length" not in extra_headers:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if isinstance(body, (bytes, bytearray)):
            self.wfile.write(body)
        else:
            # The success path: an open file, never read whole into memory
            # -- `_CHUNK_SIZE` bounds how much of one tenant's dump this
            # process ever holds at once, regardless of the dump's size.
            try:
                shutil.copyfileobj(body, self.wfile, length=_CHUNK_SIZE)
            finally:
                body.close()


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"dump_endpoint_server: {name} must be set")
    return value


def main(argv: list[str] | None = None) -> int:
    token = _require_env("DUMP_ENDPOINT_TOKEN")
    # No 0.0.0.0 default: db1 has no public interface, but it shares one
    # private subnet with every other estate host (app1, edge1, mon1,
    # ops1) -- see dump-endpoint.md's "Reachability". Binding wide would
    # still answer any of them, so the address is a required, explicit
    # value, never a silent default.
    host = _require_env("DUMP_ENDPOINT_HOST")
    port = int(os.environ.get("DUMP_ENDPOINT_PORT", "8420"))
    socket_path = os.environ.get("DUMP_ENDPOINT_SOCKET_PATH", DEFAULT_SOCKET)
    # The one peer this process answers at all, checked per request
    # alongside the bearer token -- required for the same reason `host` is:
    # see dump-endpoint.md and `_require_allowed_source`.
    allowed_source = _require_env("DUMP_ENDPOINT_ALLOWED_SOURCE")
    timeout = int(os.environ.get("DUMP_ENDPOINT_TIMEOUT_SECONDS", "60"))

    handler = type(
        "ConfiguredDumpEndpointHandler",
        (DumpEndpointHandler,),
        {
            "expected_token": token,
            "allowed_source": allowed_source,
            "socket_path": socket_path,
            "timeout": timeout,
        },
    )
    # A single-threaded HTTPServer, deliberately: it answers one request at
    # a time, which is the whole of what "one tenant dumped at a time"
    # needs at this layer. Alerting on a caller's wait for that turn is a
    # separate, tracked control, not this module's to add.
    server = HTTPServer((host, port), handler)
    print(f"dump_endpoint_server: listening on {host}:{port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

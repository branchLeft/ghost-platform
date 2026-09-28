#!/usr/bin/env python3
"""The tenant database host's one dial-in surface: a small HTTP server that
answers one request shape, `GET /dump/<tenant>`, and initiates nothing of
its own.

LLD-2 §03 names the shape once for the whole estate and asks every pull
channel to share it rather than each re-deriving one: bearer-token
authenticated, "answers, never calls". `services/mailgun-shim`'s `GET
/drain` (`services/mailgun-shim/src/routes/drain.ts`,
`services/mailgun-shim/src/drainAuth.ts`) is the concrete shape that
already exists; this module is the same shape applied to a tenant's
database dump rather than its queued mail, per Rob's 2026-09-28 ruling on
branchLeft/workspace#1203 (`transport=a`): "the worker fetches dumps from a
small dump endpoint on the database host, using the same HTTP-and-bearer-
token pattern as the mail collector."

Three properties this module exists to hold, each independent of the
others:

  1. **Authentication is a constant-time compare.** `hmac.compare_digest`,
     mirroring `drainAuth.ts`'s own reasoning: a timing side-channel on the
     token itself, distinguishable by response latency across many
     requests, is exactly the class of leak that matters for an endpoint
     whose only credential gates a tenant's database dump.
  2. **The tenant id is validated strictly**, against
     `naming.py`'s own `validate_tenant_name` -- the same pattern
     `dump_tenant.py` and every other tenant-scoped script in this repo
     already enforces, not a second, looser copy of it.
  3. **A caller can never name a path.** The only thing this server ever
     reads out of a request is the tenant slug, and the only thing it ever
     does with it is hand it to `dump_tenant.run_dump`, which turns it into
     a MySQL database name and nothing else. There is no parameter, header
     or body field anywhere in this module's request handling that reaches
     a filesystem path, a socket path or a shell command. `run_dump` always
     runs against this module's own fixed `DEFAULT_SOCKET`.

`DB_DUMP_MYSQL_PWD` never lives on this host at rest -- see
`backup_worker.py`'s own module docstring for the settled design decision
this implements the other half of: the org/control-side worker holds it
(read from the password manager at run time) and sends it once, per
request, in the `X-Db-Dump-Mysql-Pwd` header. This server never writes it
to disk, never logs it, and holds it only for the duration of the one
`run_dump` call it is used for.

**Why the response is buffered, not streamed live.** A caller must be able
to trust the HTTP status line: 200 means a complete, floor-checked dump
follows; a nonzero producer exit must never surface as a 200 with a
truncated body, because `pull_encrypt_store.py`'s caller contract is that
nothing is ever stored before a confirmed 0 exit, and it decides that from
the transport's return value alone. Streaming `dump_tenant.py`'s stdout
live into the HTTP response would mean committing to a 200 before knowing
whether it finishes cleanly. Buffering into an anonymous `tempfile.
TemporaryFile()` first (never a named path -- nothing here ever chooses a
filename a second request or a restart could collide with or a caller
could name) means the status line is only ever written once the real
outcome is known, and `Content-Length` is always exact, which is what lets
`DumpEndpointTransport` on the other end detect a connection that dropped
mid-response rather than silently treating a truncated body as success.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import sys
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer

from dump_tenant import DEFAULT_SOCKET, DumpError, run_dump
from naming import InvalidTenantName, validate_tenant_name

BEARER_PREFIX = "Bearer "
MYSQL_PWD_HEADER = "X-Db-Dump-Mysql-Pwd"

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
    presented = parse_bearer_token(headers.get("Authorization"))
    if presented is None or not constant_time_token_equals(presented, expected_token):
        raise DumpEndpointError(HTTPStatus.UNAUTHORIZED, "Unauthorized")


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
    socket_path: str = DEFAULT_SOCKET,
    run_dump=run_dump,
) -> tuple[HTTPStatus, bytes, dict[str, str]]:
    """The whole of this server's request logic, kept independent of
    `BaseHTTPRequestHandler` so it can be unit-tested directly against
    plain arguments rather than through a real socket.

    Always returns `(status, body, extra_headers)`, on every path --
    `DumpEndpointError` (auth, routing, malformed-request refusals) is
    caught here, not left for a caller to handle, so this function has one
    calling convention throughout rather than "return a tuple, except when
    it raises". `body` is the complete dump on a 200; a JSON error object
    -- never the dump's own plaintext -- on every other status.
    `extra_headers` never includes `Content-Length` (the caller sets that
    from `len(body)`, which is always exact because `body` is never
    assembled before the underlying subprocess has finished).
    """
    try:
        return _handle_dump_request(
            path=path,
            headers=headers,
            expected_token=expected_token,
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
    socket_path: str,
    run_dump,
) -> tuple[HTTPStatus, bytes, dict[str, str]]:
    """The happy-path/refusal logic -- raises `DumpEndpointError` for every
    refusal, `handle_dump_request` above is the one place that turns it
    into a wire response."""
    _require_bearer_token(headers, expected_token)
    tenant = _tenant_from_path(path)

    try:
        validate_tenant_name(tenant)
    except InvalidTenantName as exc:
        raise DumpEndpointError(HTTPStatus.BAD_REQUEST, str(exc)) from None

    mysql_pwd = headers.get(MYSQL_PWD_HEADER)
    if not mysql_pwd:
        raise DumpEndpointError(HTTPStatus.BAD_REQUEST, f"{MYSQL_PWD_HEADER} must be set and non-empty")

    with tempfile.TemporaryFile(prefix="dump-endpoint-", suffix=".sql") as dump_file:
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

        dump_file.seek(0)
        body = dump_file.read()

    return HTTPStatus.OK, body, {"Content-Type": "application/octet-stream"}


class DumpEndpointHandler(BaseHTTPRequestHandler):
    """Thin adapter onto `handle_dump_request` -- see that function's own
    docstring for the actual request logic. `expected_token` and
    `socket_path` are read from the class attributes `main()` sets on a
    per-process subclass, the same pattern `http.server`'s own
    `test()` helper uses, since `HTTPServer` constructs a handler instance
    per request with no constructor hook of its own to pass extra state
    through."""

    expected_token: str = ""
    socket_path: str = DEFAULT_SOCKET
    # Overridable per test subclass, the same way expected_token and
    # socket_path are -- lets a test point this handler at a fake producer
    # and prove the real HTTP request/response cycle (headers, status
    # codes, Content-Length) without a real MySQL socket, without mocking
    # anything inside handle_dump_request itself.
    run_dump = staticmethod(run_dump)
    server_version = "branchleft-dump-endpoint/1"

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
            socket_path=self.socket_path,
            run_dump=self.run_dump,
        )
        self.send_response(status)
        for name, value in extra_headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"dump_endpoint_server: {name} must be set")
    return value


def main(argv: list[str] | None = None) -> int:
    token = _require_env("DUMP_ENDPOINT_TOKEN")
    host = os.environ.get("DUMP_ENDPOINT_HOST", "0.0.0.0")
    port = int(os.environ.get("DUMP_ENDPOINT_PORT", "8420"))
    socket_path = os.environ.get("DUMP_ENDPOINT_SOCKET_PATH", DEFAULT_SOCKET)

    handler = type(
        "ConfiguredDumpEndpointHandler",
        (DumpEndpointHandler,),
        {"expected_token": token, "socket_path": socket_path},
    )
    # A single-threaded HTTPServer, deliberately: it answers one request at
    # a time, which is the whole of what "one tenant dumped at a time"
    # needs at this layer. Alerting on how long a caller waited for that
    # turn is a separate control, tracked on branchLeft/workspace#1158's
    # `lock=a` ruling, not this module's to add.
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

#!/usr/bin/env python3
"""One demo slot's health router, installed at
/usr/local/lib/branchleft/health_router.py and run by the static
`branchleft-health-router@<slot>` unit.

Listens on the slot's one loopback health port. Each edge check names its
colour in the X-Colour-Upstream header; the router forwards it to that
colour's drain sidecar over a unix socket and answers 200 only when the
sidecar did. Everything else is 503. See health_router.md for what each
refusal means and why the router holds no state, reaches nothing but the sockets
and knows nothing of either colour's lifecycle.
"""

from __future__ import annotations

import argparse
import http.server
import os
import re
import socket
import stat
import sys
from typing import Sequence

# Mirrors render_demo_edge.py. Duplicated rather than imported: this file is
# installed alone on the demo host. test_health_router.py fails if either
# copy drifts from its source.
COLOURS: tuple[str, ...] = ("a", "b")
SLOT_NAMES: tuple[str, ...] = tuple(str(n) for n in range(7))
EDGE_ADDR = "127.0.0.1"
APP_PORT_BASE = 9300
HEALTH_PORT_BASE = 9100
COLOUR_HEADER = "X-Colour-Upstream"
HEALTH_URI = "/healthz"

ROUTER_USER = "demo-router"
ROUTER_UID = 30008
SOCKET_ROOT = "/var/lib/branchleft/demo-router"
SOCKET_NAME = "health.sock"
SOCKET_DIR_MODE = 0o700

BACKEND_TIMEOUT_SECONDS = 1.5
CLIENT_TIMEOUT_SECONDS = 3.0
MAX_BACKEND_RESPONSE_BYTES = 8192
STATUS_LINE = re.compile(rb"\AHTTP/1\.[01] ([0-9]{3}) ")


class SocketRefused(Exception):
    """The socket, or a directory on the way to it, is not what the router
    will trust. Always answered 503, never repaired."""


def slot_app_port(slot: str, colour: str) -> int:
    return APP_PORT_BASE + int(slot) * 2 + (1 if colour == "b" else 0)


def slot_health_port(slot: str) -> int:
    return HEALTH_PORT_BASE + int(slot)


def colour_by_upstream(slot: str) -> dict[str, str]:
    """The only header values this router accepts, each naming one colour.
    The colour is looked up whole; nothing in the header is ever parsed into
    a path."""
    return {f"{EDGE_ADDR}:{slot_app_port(slot, colour)}": colour for colour in COLOURS}


def socket_path(root: str, slot: str, colour: str) -> str:
    if slot not in SLOT_NAMES or colour not in COLOURS:
        raise ValueError(f"unknown slot or colour: {slot!r} {colour!r}")
    return os.path.join(root, slot, colour, SOCKET_NAME)


def _require_dir(path: str, owner_uid: int) -> None:
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise SocketRefused(f"{path} cannot be inspected ({exc.strerror})") from exc
    if not stat.S_ISDIR(st.st_mode):
        raise SocketRefused(f"{path} is not a directory")
    if st.st_uid != owner_uid:
        raise SocketRefused(f"{path} is owned by uid {st.st_uid}, expected {owner_uid}")
    if stat.S_IMODE(st.st_mode) != SOCKET_DIR_MODE:
        raise SocketRefused(f"{path} has mode {oct(stat.S_IMODE(st.st_mode))}, expected 0o700")


def verify_socket(root: str, slot: str, colour: str, owner_uid: int) -> str:
    """Returns the colour's socket path once every link of it has been
    checked, or raises. Checked on every request, so a directory changed
    after start is refused on the next check rather than trusted from the
    last. The root itself must belong to root or the router and be
    writable by nobody else, because whoever can write it can replace the
    slot directory under the check."""
    try:
        root_st = os.lstat(root)
    except OSError as exc:
        raise SocketRefused(f"{root} cannot be inspected ({exc.strerror})") from exc
    if not stat.S_ISDIR(root_st.st_mode):
        raise SocketRefused(f"{root} is not a directory")
    if root_st.st_uid not in (0, owner_uid) or root_st.st_mode & 0o022:
        raise SocketRefused(f"{root} is writable by someone other than root or the router")
    _require_dir(os.path.join(root, slot), owner_uid)
    _require_dir(os.path.join(root, slot, colour), owner_uid)
    path = socket_path(root, slot, colour)
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise SocketRefused(f"{path} cannot be inspected ({exc.strerror})") from exc
    if not stat.S_ISSOCK(st.st_mode):
        raise SocketRefused(f"{path} is not a socket")
    if st.st_uid != owner_uid:
        raise SocketRefused(f"{path} is owned by uid {st.st_uid}, expected {owner_uid}")
    return path


def sidecar_status(path: str, timeout: float = BACKEND_TIMEOUT_SECONDS) -> int:
    """The HTTP status the sidecar answered on `path`. Any failure to ask or
    to understand the answer is an exception, never a status."""
    request = f"GET {HEALTH_URI} HTTP/1.0\r\nHost: sidecar\r\nConnection: close\r\n\r\n".encode()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(path)
        conn.sendall(request)
        received = b""
        while len(received) < MAX_BACKEND_RESPONSE_BYTES and b"\r\n" not in received:
            chunk = conn.recv(1024)
            if not chunk:
                break
            received += chunk
    match = STATUS_LINE.match(received)
    if match is None:
        raise OSError("sidecar answered something that is not an HTTP status line")
    return int(match.group(1))


def decide(root: str, slot: str, owner_uid: int, upstream_values: Sequence[str]) -> tuple[int, str]:
    """The router's whole decision for one check: (status, reason). 200 only
    when exactly one header names a colour of this slot and that colour's
    sidecar, reached over its own verified socket, answered 200."""
    if len(upstream_values) != 1:
        return 503, "no single colour named"
    colour = colour_by_upstream(slot).get(upstream_values[0].strip())
    if colour is None:
        return 503, "not a colour of this slot"
    try:
        path = verify_socket(root, slot, colour, owner_uid)
        status = sidecar_status(path)
    except (SocketRefused, OSError) as exc:
        return 503, f"colour {colour} unreachable: {exc}"
    if status != 200:
        return 503, f"colour {colour} sidecar answered {status}"
    return 200, f"colour {colour} healthy"


def make_handler(root: str, slot: str, owner_uid: int) -> type[http.server.BaseHTTPRequestHandler]:
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        timeout = CLIENT_TIMEOUT_SECONDS

        def do_GET(self) -> None:  # noqa: N802 - http.server's naming
            if self.path != HEALTH_URI:
                self._reply(404, "not found")
                return
            status, reason = decide(root, slot, owner_uid, self.headers.get_all(COLOUR_HEADER) or [])
            if status != 200:
                sys.stderr.write(f"health_router slot {slot}: 503 {reason}\n")
            self._reply(status, "ok" if status == 200 else "unhealthy")

        def _reply(self, status: int, body: str) -> None:
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    return Handler


class RouterServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(
    slot: str,
    *,
    root: str = SOCKET_ROOT,
    owner_uid: int = ROUTER_UID,
    port: int | None = None,
) -> RouterServer:
    if slot not in SLOT_NAMES:
        raise ValueError(f"unknown slot {slot!r}")
    bind_port = slot_health_port(slot) if port is None else port
    return RouterServer((EDGE_ADDR, bind_port), make_handler(root, slot, owner_uid))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", required=True)
    parser.add_argument("--socket-root", default=SOCKET_ROOT)
    parser.add_argument("--owner-uid", type=int, default=ROUTER_UID)
    args = parser.parse_args(argv)
    if args.slot not in SLOT_NAMES:
        print(f"health_router: unknown slot {args.slot!r}", file=sys.stderr)
        return 2
    server = make_server(args.slot, root=args.socket_root, owner_uid=args.owner_uid)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

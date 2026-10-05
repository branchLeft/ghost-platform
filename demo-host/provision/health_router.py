#!/usr/bin/env python3
"""One demo slot's health router, run by the static `branchleft-health-router@<slot>` unit.

Answers the edge's colour-named check on the slot's one loopback health port
from that colour's drain sidecar, over a unix socket. See health_router.md.
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import os
import re
import socket
import stat
import sys
from typing import Iterator, Sequence

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


def _open_dir(name: str, parent_fd: int | None) -> int:
    """Opens one directory without following a symlink, relative to
    `parent_fd` when given. The returned descriptor names the directory
    object itself: renaming or replacing the directory afterwards does not
    change what it refers to."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise SocketRefused(f"{name} cannot be opened as a directory ({exc.strerror})") from exc


def _require_trusted(fd: int, label: str, owner_uid: int) -> None:
    """A directory whose entries only root or the router can change. Whoever
    can write one can rename what is inside it, so it must be neither group
    nor world writable."""
    st = os.fstat(fd)
    if st.st_uid not in (0, owner_uid) or st.st_mode & 0o022:
        raise SocketRefused(f"{label} is writable by someone other than root or the router")


def _require_private(fd: int, label: str, owner_uid: int) -> None:
    st = os.fstat(fd)
    if st.st_uid != owner_uid:
        raise SocketRefused(f"{label} is owned by uid {st.st_uid}, expected {owner_uid}")
    if stat.S_IMODE(st.st_mode) != SOCKET_DIR_MODE:
        raise SocketRefused(f"{label} has mode {oct(stat.S_IMODE(st.st_mode))}, expected 0o700")


def _pinned_path(colour_fd: int, name: str, fallback: str) -> str:
    """A path that reaches `name` inside the directory `colour_fd` holds
    open, however that directory is later renamed. Linux resolves it through
    /proc; the router only runs on Linux, and other systems (a developer's
    machine) get the plain path."""
    if sys.platform == "linux":
        return f"/proc/self/fd/{colour_fd}/{name}"
    return fallback


@contextlib.contextmanager
def pinned_socket(root: str, slot: str, colour: str, owner_uid: int) -> Iterator[str]:
    """Yields the colour's socket path once every link of it has been checked,
    or raises. Checked on every request. Each directory is opened once, the
    next relative to it, and the path yielded goes through the last
    descriptor, so a rename between check and connect cannot redirect it.
    See health_router.md ("How the check and the connect stay one")."""
    plain = socket_path(root, slot, colour)
    root = os.path.normpath(root)
    fds: list[int] = []
    try:
        parent_fd = _open_dir(os.path.dirname(root), None)
        fds.append(parent_fd)
        _require_trusted(parent_fd, os.path.dirname(root), owner_uid)
        root_fd = _open_dir(os.path.basename(root), parent_fd)
        fds.append(root_fd)
        _require_trusted(root_fd, root, owner_uid)
        slot_fd = _open_dir(slot, root_fd)
        fds.append(slot_fd)
        _require_private(slot_fd, os.path.join(root, slot), owner_uid)
        colour_fd = _open_dir(colour, slot_fd)
        fds.append(colour_fd)
        _require_private(colour_fd, os.path.join(root, slot, colour), owner_uid)
        try:
            st = os.stat(SOCKET_NAME, dir_fd=colour_fd, follow_symlinks=False)
        except OSError as exc:
            raise SocketRefused(f"{plain} cannot be inspected ({exc.strerror})") from exc
        if not stat.S_ISSOCK(st.st_mode):
            raise SocketRefused(f"{plain} is not a socket")
        if st.st_uid != owner_uid:
            raise SocketRefused(f"{plain} is owned by uid {st.st_uid}, expected {owner_uid}")
        yield _pinned_path(colour_fd, SOCKET_NAME, plain)
    finally:
        for fd in fds:
            os.close(fd)


def verify_socket(root: str, slot: str, colour: str, owner_uid: int) -> str:
    """Runs every check `pinned_socket` runs and returns the plain path. For
    callers that only need the verdict; `decide` connects inside the block."""
    with pinned_socket(root, slot, colour, owner_uid):
        return socket_path(root, slot, colour)


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
        with pinned_socket(root, slot, colour, owner_uid) as path:
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

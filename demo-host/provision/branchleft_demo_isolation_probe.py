#!/usr/bin/python3 -I
# Run from inside one demo slot's network namespace, as that slot's own uid.
# Tries every route from the slot to another slot, the demo host and the
# estate, and every file path a slot must not read. Prints one line per route:
#   REFUSED <route>     the route did not open (a refusal, a timeout, no route)
#   REACHED <route>     the route opened: isolation is broken
#   UNCHECKED <route>   the route could not be tried, so it proves nothing
# First it tries a control route that must open (the spool's allowed port); if
# it does not, the namespace is not the slot's and nothing is printed as a verdict.
# Exit 0 only when the control opened and every other route was tried and refused.
# What it checks, and what it does not: branchleft_demo_isolation_probe.md.
#
# Standard library only, and no shell.

from __future__ import annotations

import argparse
import errno
import os
import socket
import sys
from collections.abc import Callable
from dataclasses import dataclass

# Public addresses a slot must never reach. Fixed literals, not estate data.
# Always probed on the demo host; the unit tests patch this out so they do not
# depend on the sandbox's own internet access.
PUBLIC_ROUTES: tuple[tuple[str, str, int], ...] = (
    ("cloud metadata", "169.254.169.254", 80),
    ("public DNS", "1.1.1.1", 53),
    ("public address", "1.1.1.1", 443),
)

# An unreachable network or host is a refusal to reach it. Every other OS error
# (a name that does not resolve, a denied connect, no descriptors) is UNCHECKED.
REFUSED_ERRNOS = frozenset({errno.EHOSTUNREACH, errno.ENETUNREACH})

EXIT_OK = 0
EXIT_REACHED = 1
EXIT_USAGE = 2


@dataclass(frozen=True)
class TcpRoute:
    label: str
    host: str
    port: int


@dataclass(frozen=True)
class PathRoute:
    label: str
    path: str


@dataclass(frozen=True)
class Outcome:
    verdict: str  # REACHED, REFUSED or UNCHECKED
    label: str
    reason: str = ""

    def line(self) -> str:
        if self.verdict == "UNCHECKED":
            return f"UNCHECKED {self.label}: {self.reason}"
        return f"{self.verdict} {self.label}"


def classify_tcp_error(label: str, error: OSError) -> Outcome:
    if isinstance(error, (ConnectionRefusedError, TimeoutError)) or error.errno in REFUSED_ERRNOS:
        return Outcome("REFUSED", label)
    code = "" if error.errno is None else f" {errno.errorcode.get(error.errno, str(error.errno))}"
    return Outcome("UNCHECKED", label, f"{type(error).__name__}{code}")


def probe_tcp(route: TcpRoute, timeout: float) -> Outcome:
    try:
        with socket.create_connection((route.host, route.port), timeout=timeout):
            return Outcome("REACHED", route.label)
    except OSError as error:
        return classify_tcp_error(route.label, error)


def probe_path(route: PathRoute) -> Outcome:
    # Listing a directory, or reading a file, must be denied. Only a permission
    # refusal counts as REFUSED; a missing or odd path is UNCHECKED.
    try:
        if os.path.isdir(route.path):
            os.listdir(route.path)
        else:
            with open(route.path, "rb") as handle:
                handle.read(1)
        return Outcome("REACHED", route.label)
    except PermissionError:
        return Outcome("REFUSED", route.label)
    except OSError as error:
        return Outcome("UNCHECKED", route.label, type(error).__name__)


def tcp_routes(
    gateway: str,
    peer_ports: list[int],
    host_ports: list[int],
    estate: list[tuple[str, int]],
    spool_address: str,
    spool_ports: list[int],
    spool_allowed_port: int,
) -> list[TcpRoute]:
    routes: list[TcpRoute] = []
    for port in peer_ports:
        routes.append(TcpRoute(f"slot B port {port} on loopback", "127.0.0.1", port))
        routes.append(TcpRoute(f"slot B port {port} on bridge gateway", gateway, port))
    for port in host_ports:
        routes.append(TcpRoute(f"host service {port} on bridge gateway", gateway, port))
    for address, port in estate:
        routes.append(TcpRoute(f"estate address {address}:{port}", address, port))
    for port in spool_ports:
        if port == spool_allowed_port:
            continue  # the one drain/submit port is the control, not a route to refuse
        routes.append(TcpRoute(f"mail spool {spool_address}:{port}", spool_address, port))
    for label, host, port in PUBLIC_ROUTES:
        routes.append(TcpRoute(label, host, port))
    return routes


def parse_port(text: str) -> int:
    value = int(text)
    if not 1 <= value <= 65535:
        raise argparse.ArgumentTypeError(f"port {value} is out of range")
    return value


def parse_estate(text: str) -> tuple[str, int]:
    address, _, port = text.rpartition(":")
    if not address or not port:
        raise argparse.ArgumentTypeError(f"'{text}' is not ADDRESS:PORT")
    return address, parse_port(port)


def build_parser() -> argparse.ArgumentParser:
    # Every route class is required: a class left out is a usage error, never a shorter run that passes.
    parser = argparse.ArgumentParser(prog="branchleft-demo-isolation-probe")
    parser.add_argument("--gateway", required=True, help="the slot's bridge gateway address")
    parser.add_argument("--peer-port", type=parse_port, action="append", required=True,
                        help="a port of another slot (Ghost, health router, sidecar)")
    parser.add_argument("--host-port", type=parse_port, action="append", required=True,
                        help="a port the host serves on the bridge gateway")
    parser.add_argument("--estate", type=parse_estate, action="append", required=True,
                        help="an estate private address as ADDRESS:PORT")
    parser.add_argument("--spool-address", required=True)
    parser.add_argument("--spool-port", type=parse_port, action="append", required=True)
    parser.add_argument("--spool-allowed-port", type=parse_port, required=True,
                        help="the one spool port a slot may use: the control, which must open")
    parser.add_argument("--file-path", action="append", required=True,
                        help="a path this slot must not list or read")
    parser.add_argument("--expect-uid", type=int, required=True,
                        help="refuse to run as any other uid")
    parser.add_argument("--timeout", type=float, default=3.0)
    return parser


def main(argv: list[str], geteuid: Callable[[], int] = os.geteuid) -> int:
    args = build_parser().parse_args(argv)

    euid = geteuid()
    if euid == 0:
        print("branchleft-demo-isolation-probe: refuses to run as root; run as the slot's own uid",
              file=sys.stderr)
        return EXIT_USAGE
    if euid != args.expect_uid:
        print(f"branchleft-demo-isolation-probe: running as uid {euid}, expected {args.expect_uid}",
              file=sys.stderr)
        return EXIT_USAGE

    control = TcpRoute("control: mail spool allowed port", args.spool_address, args.spool_allowed_port)
    control_outcome = probe_tcp(control, args.timeout)
    if control_outcome.verdict != "REACHED":
        print(f"CONTROL NOT REACHED {control.label} ({control_outcome.verdict.lower()}): the namespace "
              "or the spool is not as expected, so nothing is proven", file=sys.stderr)
        return EXIT_USAGE
    print(f"CONTROL REACHED {control.label}", flush=True)

    routes = tcp_routes(
        gateway=args.gateway,
        peer_ports=args.peer_port,
        host_ports=args.host_port,
        estate=args.estate,
        spool_address=args.spool_address,
        spool_ports=args.spool_port,
        spool_allowed_port=args.spool_allowed_port,
    )
    paths = [PathRoute(f"file {path}", path) for path in args.file_path]

    outcomes = [probe_tcp(route, args.timeout) for route in routes]
    outcomes += [probe_path(route) for route in paths]
    for outcome in outcomes:
        print(outcome.line(), flush=True)

    if any(outcome.verdict == "REACHED" for outcome in outcomes):
        return EXIT_REACHED
    if any(outcome.verdict == "UNCHECKED" for outcome in outcomes):
        print("branchleft-demo-isolation-probe: a route was not tried; nothing is proven", file=sys.stderr)
        return EXIT_USAGE
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

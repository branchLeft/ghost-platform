"""Unit tests for branchleft_demo_isolation_probe.py against real loopback sockets, real file modes and
mocked connect errors; see branchleft_demo_isolation_probe.md, "Proof". The directory-permission
cases are skipped when the suite runs as root, because root reads every file and the probe refuses root.
The IPv6 cases are skipped where the host has no IPv6 loopback."""

from __future__ import annotations

import argparse
import contextlib
import errno
import importlib.util
import io
import os
import socket
import sys
import tempfile
import threading
import unittest
from collections.abc import Callable
from types import ModuleType
from typing import Any
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "branchleft_demo_isolation_probe.py")
ROOT = hasattr(os, "geteuid") and os.geteuid() == 0


def load_program() -> ModuleType:
    spec = importlib.util.spec_from_file_location("branchleft_demo_isolation_probe", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look the module up by name
    spec.loader.exec_module(module)
    return module


probe = load_program()


def closed_loopback_port() -> int:
    # Bind, learn the port, close it again: nothing listens there now.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def closed_udp_port() -> int:
    # A UDP port with nothing bound: a datagram to it comes back as ICMP port unreachable.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class UdpResponder:
    """A real loopback UDP port that answers every datagram: a UDP route to it is REACHED."""

    def __enter__(self) -> int:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(0.1)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()
        return int(self.sock.getsockname()[1])

    def serve(self) -> None:
        while not self.stop.is_set():
            try:
                query, peer = self.sock.recvfrom(512)
            except TimeoutError:
                continue
            self.sock.sendto(query, peer)

    def __exit__(self, *exc: object) -> None:
        self.stop.set()
        self.thread.join(timeout=3)
        self.sock.close()


class SilentUdpPort:
    """A real loopback UDP port that never answers: a datagram to it is silence, as from a dropping resolver."""

    def __enter__(self) -> int:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        return int(self.sock.getsockname()[1])

    def __exit__(self, *exc: object) -> None:
        self.sock.close()


def ipv6_loopback_available() -> bool:
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            sock.bind(("::1", 0))
        return True
    except OSError:
        return False


IPV6_LOOPBACK = ipv6_loopback_available()
NO_IPV6 = "this host has no IPv6 loopback"


class Listener:
    """A real loopback listener: a route to it is REACHED."""

    def __enter__(self) -> int:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        return int(self.sock.getsockname()[1])

    def __exit__(self, *exc: object) -> None:
        self.sock.close()


def run_main(argv: list[str], geteuid: Callable[[], int] = lambda: 1000) -> tuple[int, str]:
    # Returns the exit code and everything printed to stdout and stderr.
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        try:
            code = probe.main(argv, geteuid=geteuid)
        except SystemExit as exit_request:  # argparse exits itself on a bad or missing argument
            code = int(exit_request.code or 0)
    return code, out.getvalue()


def argv_pairs(control: int, closed: int, denied: str, uid: str = "1000",
               udp_control: int | None = None) -> list[tuple[str, str]]:
    # Every route class present: the control is the allowed spool port, and it is also the only
    # spool port, so nothing else on the spool is probed. The gateway control is the same loopback port.
    # The UDP control is a closed UDP port unless the caller says otherwise, so by default it does not answer.
    udp = closed_udp_port() if udp_control is None else udp_control
    return [
        ("--gateway", "127.0.0.1"),
        ("--gateway-control-port", str(control)),
        ("--peer-port", str(closed)),
        ("--host-port", str(closed)),
        ("--estate", f"127.0.0.1:{closed}"),
        ("--spool-address", "127.0.0.1"),
        ("--spool-port", str(control)),
        ("--spool-allowed-port", str(control)),
        ("--file-path", denied),
        ("--ipv6-route", f"[::1]:{closed}"),
        ("--udp-control", f"127.0.0.1:{udp}"),
        ("--dns-resolver", f"127.0.0.1:{closed_udp_port()}"),
        ("--expect-uid", uid),
        ("--timeout", "1"),
    ]


def to_argv(pairs: list[tuple[str, str]]) -> list[str]:
    return [item for pair in pairs for item in pair]


def without(pairs: list[tuple[str, str]], flag: str) -> list[tuple[str, str]]:
    return [pair for pair in pairs if pair[0] != flag]


def replaced(pairs: list[tuple[str, str]], flag: str, value: str) -> list[tuple[str, str]]:
    return [(name, value if name == flag else old) for name, old in pairs]


def value_of(pairs: list[tuple[str, str]], flag: str) -> str:
    return next(value for name, value in pairs if name == flag)


def denied_directory(tmp: str) -> str:
    target = os.path.join(tmp, "slot")
    os.mkdir(target)
    os.chmod(target, 0o000)
    return target


class ClassifyTcpErrorTests(unittest.TestCase):
    """Item 1: only a refusal, a timeout and an unreachable network are REFUSED; every other error is UNCHECKED."""

    def probe_with(self, error: BaseException) -> Any:  # the loaded module's Outcome, untyped to mypy
        with mock.patch("socket.create_connection", side_effect=error):
            return probe.probe_tcp(probe.TcpRoute("route", "192.0.2.1", 9), timeout=1)

    def test_connection_refused_is_refused(self) -> None:
        outcome = self.probe_with(ConnectionRefusedError(errno.ECONNREFUSED, "refused"))
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_timeout_is_refused(self) -> None:
        self.assertEqual(self.probe_with(TimeoutError("timed out")).verdict, "REFUSED")

    def test_no_route_to_host_is_refused(self) -> None:
        outcome = self.probe_with(OSError(errno.EHOSTUNREACH, "no route to host"))
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_network_unreachable_is_refused(self) -> None:
        outcome = self.probe_with(OSError(errno.ENETUNREACH, "network unreachable"))
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_name_that_does_not_resolve_is_unchecked(self) -> None:
        outcome = self.probe_with(socket.gaierror(-2, "Name or service not known"))
        self.assertEqual(outcome.verdict, "UNCHECKED")
        self.assertIn("gaierror", outcome.reason)

    def test_permission_denied_on_connect_is_unchecked(self) -> None:
        outcome = self.probe_with(PermissionError(errno.EPERM, "operation not permitted"))
        self.assertEqual(outcome.verdict, "UNCHECKED")
        self.assertIn("EPERM", outcome.reason)

    def test_out_of_file_descriptors_is_unchecked(self) -> None:
        outcome = self.probe_with(OSError(errno.EMFILE, "too many open files"))
        self.assertEqual(outcome.verdict, "UNCHECKED")
        self.assertIn("EMFILE", outcome.reason)

    def test_unchecked_is_never_printed_as_refused(self) -> None:
        outcome = self.probe_with(PermissionError(errno.EACCES, "denied"))
        self.assertTrue(outcome.line().startswith("UNCHECKED "))


class TcpRouteTests(unittest.TestCase):
    def test_a_listening_loopback_port_is_reached(self) -> None:
        with Listener() as port:
            outcome = probe.probe_tcp(probe.TcpRoute("listener", "127.0.0.1", port), timeout=3)
        self.assertEqual(outcome.verdict, "REACHED")
        self.assertEqual(outcome.label, "listener")

    def test_a_closed_port_is_refused(self) -> None:
        port = closed_loopback_port()
        outcome = probe.probe_tcp(probe.TcpRoute("closed", "127.0.0.1", port), timeout=3)
        self.assertEqual(outcome.verdict, "REFUSED")


class PathRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    @unittest.skipIf(ROOT, "root reads every file")
    def test_a_directory_with_no_mode_bits_is_refused(self) -> None:
        target = denied_directory(self.tmp.name)
        self.addCleanup(os.chmod, target, 0o755)
        outcome = probe.probe_path(probe.PathRoute("slot dir", target))
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_readable_directory_is_reached(self) -> None:
        # The sabotage control: open the slot directory's mode and the file route must report REACHED.
        target = os.path.join(self.tmp.name, "slot")
        os.mkdir(target)
        outcome = probe.probe_path(probe.PathRoute("slot dir", target))
        self.assertEqual(outcome.verdict, "REACHED")

    def test_a_missing_path_is_unchecked_not_refused(self) -> None:
        missing = os.path.join(self.tmp.name, "no-such-path")
        outcome = probe.probe_path(probe.PathRoute("gone", missing))
        self.assertEqual(outcome.verdict, "UNCHECKED")

    @unittest.skipIf(ROOT, "root reads every directory")
    def test_a_search_only_directory_is_not_refused(self) -> None:
        # Search without read: the listing is denied, but names under the directory still open.
        # Nothing here names those files, so the route cannot be called REFUSED: it is UNCHECKED.
        target = os.path.join(self.tmp.name, "slot")
        os.mkdir(target)
        os.chmod(target, 0o311)
        self.addCleanup(os.chmod, target, 0o755)
        outcome = probe.probe_path(probe.PathRoute("slot dir", target))
        self.assertEqual(outcome.verdict, "UNCHECKED")
        self.assertIn("search allowed", outcome.reason)

    def test_a_readable_file_under_a_search_only_directory_is_reached(self) -> None:
        # Item 2, named file: the file route reads the object it names, so the leak is REACHED.
        target = os.path.join(self.tmp.name, "slot")
        os.mkdir(target)
        named = os.path.join(target, "secret")
        with open(named, "w") as handle:
            handle.write("x")
        os.chmod(target, 0o311)
        self.addCleanup(os.chmod, target, 0o755)
        outcome = probe.probe_path(probe.PathRoute("slot file", named))
        self.assertEqual(outcome.verdict, "REACHED")


class RouteBuildTests(unittest.TestCase):
    def test_peer_ports_are_probed_on_loopback_and_the_gateway(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[9303], host_ports=[], estate=[],
            spool_address="172.20.0.1", spool_ports=[], spool_allowed_port=0,
        )
        hosts = sorted((route.host, route.port) for route in routes if "slot B" in route.label)
        self.assertEqual(hosts, [("127.0.0.1", 9303), ("172.20.0.1", 9303)])

    def test_the_gateway_routes_are_marked_as_gateway_routes(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[9303], host_ports=[22], estate=[],
            spool_address="172.20.0.1", spool_ports=[], spool_allowed_port=0,
        )
        marked = sorted(route.label for route in routes if route.via_gateway)
        self.assertEqual(marked, ["host service 22 on bridge gateway", "slot B port 9303 on bridge gateway"])

    def test_the_public_routes_are_always_present(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[], host_ports=[], estate=[],
            spool_address="172.20.0.1", spool_ports=[], spool_allowed_port=0,
        )
        labels = [route.label for route in routes]
        self.assertIn("cloud metadata", labels)
        self.assertIn("public DNS", labels)
        self.assertIn("public address", labels)

    def test_the_spool_allowed_port_is_never_probed(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[], host_ports=[], estate=[],
            spool_address="172.20.0.1", spool_ports=[2525, 25], spool_allowed_port=2525,
        )
        spool = [route.port for route in routes if route.label.startswith("mail spool")]
        self.assertEqual(spool, [25])

    def test_ipv6_routes_are_their_own_route_class(self) -> None:
        # Each IPv6 route the caller names is probed over IPv6, labelled as such.
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[], host_ports=[], estate=[],
            spool_address="172.20.0.1", spool_ports=[], spool_allowed_port=0,
            ipv6=[("fd00::1", 9303)],
        )
        ipv6 = [(route.label, route.host, route.port) for route in routes if route.label.startswith("IPv6")]
        self.assertEqual(ipv6, [("IPv6 route [fd00::1]:9303", "fd00::1", 9303)])


class GatewayControlTests(unittest.TestCase):
    """A route through the bridge gateway is REFUSED only when the gateway's own control port opened."""

    def setUp(self) -> None:
        patcher = mock.patch.object(probe, "PUBLIC_ROUTES", ())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_with_gateway(self, gateway: str, gateway_control: int, closed: int, control: int) -> tuple[int, list[str]]:
        pairs = argv_pairs(control, closed, os.path.join(self.tmp.name, "absent"))
        pairs = replaced(pairs, "--gateway", gateway)
        pairs = replaced(pairs, "--gateway-control-port", str(gateway_control))
        code, out = run_main(to_argv(pairs))
        return code, out.splitlines()

    def test_a_gateway_that_does_not_answer_its_control_reads_unchecked_not_refused(self) -> None:
        # A valid but unused gateway address: the control cannot open, so the gateway routes prove nothing.
        closed = closed_loopback_port()
        with Listener() as control:
            code, lines = self.run_with_gateway("127.0.0.2", closed, closed, control)
        self.assertEqual(code, 2)
        self.assertTrue(any(line.startswith(f"UNCHECKED slot B port {closed} on bridge gateway") for line in lines), lines)
        self.assertTrue(any(line.startswith(f"UNCHECKED host service {closed} on bridge gateway") for line in lines), lines)
        self.assertFalse(any(line.startswith("REFUSED") and "on bridge gateway" in line for line in lines), lines)

    def test_a_gateway_that_answers_its_control_is_probed_and_refused(self) -> None:
        closed = closed_loopback_port()
        with Listener() as control, Listener() as gateway_port:
            code, lines = self.run_with_gateway("127.0.0.1", gateway_port, closed, control)
        self.assertIn(f"REFUSED slot B port {closed} on bridge gateway", lines)
        self.assertNotIn(f"UNCHECKED slot B port {closed} on bridge gateway", lines)


class GatewayControlArgumentTests(unittest.TestCase):
    def test_the_gateway_control_port_is_a_required_argument(self) -> None:
        code, out = run_main(["--gateway", "127.0.0.1"])
        self.assertEqual(code, 2)
        self.assertIn("--gateway-control-port", out)


class IpAndUdpRouteTests(unittest.TestCase):
    """IPv6 TCP routes and UDP DNS to the resolver are probed, each as REFUSED, REACHED or UNCHECKED."""

    def setUp(self) -> None:
        patcher = mock.patch.object(probe, "PUBLIC_ROUTES", ())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_an_ipv6_route_must_be_bracketed_and_ipv6(self) -> None:
        self.assertEqual(probe.parse_ipv6_route("[::1]:9303"), ("::1", 9303))
        for bad in ("127.0.0.1:9303", "[127.0.0.1]:9303", "[::1]", "[::1]:70000"):
            with self.subTest(bad=bad), self.assertRaises(argparse.ArgumentTypeError):
                probe.parse_ipv6_route(bad)

    @unittest.skipUnless(IPV6_LOOPBACK, NO_IPV6)
    def test_a_listening_ipv6_port_is_reached(self) -> None:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as server:
            server.bind(("::1", 0))
            server.listen(4)
            port = int(server.getsockname()[1])
            outcome = probe.probe_tcp(probe.TcpRoute("v6", "::1", port), timeout=3)
        self.assertEqual(outcome.verdict, "REACHED")

    @unittest.skipUnless(IPV6_LOOPBACK, NO_IPV6)
    def test_a_closed_ipv6_port_is_refused(self) -> None:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            sock.bind(("::1", 0))
            port = int(sock.getsockname()[1])
        outcome = probe.probe_tcp(probe.TcpRoute("v6", "::1", port), timeout=3)
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_udp_resolver_that_answers_is_reached(self) -> None:
        server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(server.close)
        server.bind(("127.0.0.1", 0))
        server.settimeout(3)
        port = int(server.getsockname()[1])

        def answer() -> None:
            query, peer = server.recvfrom(512)
            server.sendto(query, peer)

        thread = threading.Thread(target=answer, daemon=True)
        thread.start()
        outcome = probe.probe_udp(probe.UdpRoute("udp", "127.0.0.1", port), timeout=3)
        thread.join(timeout=3)
        self.assertEqual(outcome.verdict, "REACHED")

    def test_a_udp_resolver_with_nothing_listening_is_refused(self) -> None:
        outcome = probe.probe_udp(probe.UdpRoute("udp", "127.0.0.1", closed_udp_port()), timeout=3)
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_silent_udp_resolver_is_refused_like_a_tcp_timeout(self) -> None:
        # A dropped datagram looks like a timeout, which the TCP probe already reads as REFUSED.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as silent:
            silent.bind(("127.0.0.1", 0))
            port = int(silent.getsockname()[1])
            outcome = probe.probe_udp(probe.UdpRoute("udp", "127.0.0.1", port), timeout=0.5)
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_udp_resolver_error_other_than_a_refusal_is_unchecked(self) -> None:
        with mock.patch("socket.socket.send", side_effect=PermissionError(errno.EPERM, "denied")):
            outcome = probe.probe_udp(probe.UdpRoute("udp", "127.0.0.1", 53), timeout=1)
        self.assertEqual(outcome.verdict, "UNCHECKED")

    @unittest.skipUnless(IPV6_LOOPBACK, NO_IPV6)
    def test_the_ipv6_and_udp_routes_are_each_printed(self) -> None:
        # The run prints a verdict line for the IPv6 route and for UDP DNS, not only for TCP routes.
        denied = os.path.join(self.tmp.name, "absent")
        with Listener() as control, UdpResponder() as udp_control:
            pairs = argv_pairs(control, closed_loopback_port(), denied, udp_control=udp_control)
            code, out = run_main(to_argv(pairs))
        lines = out.splitlines()
        self.assertIn(f"REFUSED IPv6 route {value_of(pairs, '--ipv6-route')}", lines, out)
        self.assertIn(f"REFUSED UDP DNS to resolver {value_of(pairs, '--dns-resolver')}", lines, out)
        self.assertEqual(code, 2, out)  # the absent path is UNCHECKED, so the run is never a pass


class UdpControlTests(unittest.TestCase):
    """Silence on a UDP route reads REFUSED only after a UDP control the slot must reach has answered."""

    def setUp(self) -> None:
        patcher = mock.patch.object(probe, "PUBLIC_ROUTES", ())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_with_udp(self, udp_control: int, dns: int) -> tuple[int, list[str]]:
        with Listener() as control:
            pairs = argv_pairs(control, closed_loopback_port(), os.path.join(self.tmp.name, "absent"),
                               udp_control=udp_control)
            pairs = replaced(pairs, "--dns-resolver", f"127.0.0.1:{dns}")
            code, out = run_main(to_argv(pairs))
        return code, out.splitlines()

    def test_silence_on_the_dns_route_is_unchecked_when_the_udp_control_is_silent(self) -> None:
        # The control is silent too, so silence on the DNS route proves nothing about the policy.
        with SilentUdpPort() as udp_control, SilentUdpPort() as dns:
            code, lines = self.run_with_udp(udp_control, dns)
        self.assertEqual(code, 2)
        self.assertTrue(any(line.startswith(f"UNCHECKED UDP DNS to resolver 127.0.0.1:{dns}") for line in lines), lines)
        self.assertFalse(any(line.startswith("REFUSED UDP DNS") for line in lines), lines)

    def test_silence_on_the_dns_route_is_refused_once_the_udp_control_answered(self) -> None:
        with UdpResponder() as udp_control, SilentUdpPort() as dns:
            _, lines = self.run_with_udp(udp_control, dns)
        self.assertIn(f"REFUSED UDP DNS to resolver 127.0.0.1:{dns}", lines, lines)

    def test_a_udp_control_that_answers_is_printed_as_reached(self) -> None:
        with UdpResponder() as udp_control, SilentUdpPort() as dns:
            _, lines = self.run_with_udp(udp_control, dns)
        self.assertIn("CONTROL REACHED control: UDP port the slot must reach", lines, lines)

    def test_a_refused_udp_control_leaves_the_dns_route_unchecked(self) -> None:
        # A UDP control with nothing listening is refused; the DNS route is then not tried at all.
        code, lines = self.run_with_udp(closed_udp_port(), closed_udp_port())
        self.assertEqual(code, 2)
        self.assertTrue(any(line.startswith("UNCHECKED UDP DNS to resolver") for line in lines), lines)
        self.assertFalse(any(line.startswith("REFUSED UDP DNS") for line in lines), lines)

    def test_the_udp_control_must_not_be_the_dns_route(self) -> None:
        # If they were the same address, a control that answers would make the DNS route REACHED.
        with Listener() as control:
            pairs = argv_pairs(control, closed_loopback_port(), os.path.join(self.tmp.name, "absent"))
            same = value_of(pairs, "--dns-resolver")
            code, out = run_main(to_argv(replaced(pairs, "--udp-control", same)))
        self.assertEqual(code, 2)
        self.assertIn("different", out)


class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        # The public routes depend on the sandbox's internet; the main tests do not need them.
        patcher = mock.patch.object(probe, "PUBLIC_ROUTES", ())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    @unittest.skipIf(ROOT, "root reads every file")
    @unittest.skipUnless(IPV6_LOOPBACK, NO_IPV6)
    def test_all_refused_exits_zero_and_prints_one_line_per_route(self) -> None:
        denied = denied_directory(self.tmp.name)
        self.addCleanup(os.chmod, denied, 0o755)
        with Listener() as control, UdpResponder() as udp_control:
            code, out = run_main(to_argv(argv_pairs(control, closed_loopback_port(), denied, udp_control=udp_control)))
        self.assertEqual(code, 0, out)
        self.assertIn("CONTROL REACHED", out)
        self.assertIn("REFUSED slot B port", out)
        self.assertNotIn("REACHED slot B", out)

    def test_a_reached_route_exits_non_zero(self) -> None:
        with Listener() as control, Listener() as peer:
            pairs = argv_pairs(control, closed_loopback_port(), os.path.join(self.tmp.name, "absent"))
            pairs = [(flag, str(peer) if flag == "--peer-port" else value) for flag, value in pairs]
            code, out = run_main(to_argv(pairs))
        self.assertEqual(code, 1)
        self.assertIn("REACHED slot B port", out)

    def test_the_control_must_be_reached(self) -> None:
        # Item 2: a control that is not reached means the namespace is wrong; the probe stops with no verdict.
        denied = os.path.join(self.tmp.name, "absent")
        code, out = run_main(to_argv(argv_pairs(closed_loopback_port(), closed_loopback_port(), denied)))
        self.assertEqual(code, 2)
        self.assertIn("CONTROL NOT REACHED", out)
        self.assertNotIn("REFUSED", out)

    def test_an_unchecked_route_exits_two_never_zero(self) -> None:
        # Item 1 end to end: EPERM on every connect, the control included, must not read as a pass.
        denied = os.path.join(self.tmp.name, "absent")
        with mock.patch("socket.create_connection", side_effect=PermissionError(errno.EPERM, "denied")):
            code, out = run_main(to_argv(argv_pairs(closed_loopback_port(), closed_loopback_port(), denied)))
        self.assertEqual(code, 2)
        self.assertNotIn("REFUSED", out)

    def test_an_unchecked_route_next_to_a_real_control_exits_two(self) -> None:
        # The control really is reached; a route whose connect fails with EPERM must still exit 2.
        denied = os.path.join(self.tmp.name, "absent")
        with Listener() as control:
            real = socket.create_connection
            def fail_the_peer(address: tuple[str, int], *args: object, **kwargs: object) -> socket.socket:
                if address[1] != control:
                    raise PermissionError(errno.EPERM, "denied")
                return real(address, *args, **kwargs)  # type: ignore[arg-type]
            with mock.patch("socket.create_connection", side_effect=fail_the_peer):
                code, out = run_main(to_argv(argv_pairs(control, closed_loopback_port(), denied)))
        self.assertEqual(code, 2)
        self.assertIn("UNCHECKED", out)
        self.assertNotIn("REFUSED slot B", out)  # the EPERM peer route is UNCHECKED, never a refusal

    def test_root_is_refused_and_nothing_is_probed(self) -> None:
        # A real, open control, so only the root check can make this run exit 2.
        with Listener() as control:
            code, out = run_main(to_argv(argv_pairs(control, closed_loopback_port(), "/x")), geteuid=lambda: 0)
        self.assertEqual(code, 2)
        self.assertIn("root", out.lower())
        self.assertNotIn("REFUSED", out)

    def test_a_different_uid_than_expected_is_refused(self) -> None:
        with Listener() as control:
            code, out = run_main(to_argv(argv_pairs(control, closed_loopback_port(), "/x", uid="1234")),
                                 geteuid=lambda: 1000)
        self.assertEqual(code, 2)
        self.assertNotIn("REFUSED", out)

    @unittest.skipIf(ROOT, "root reads every file")
    def test_each_route_class_is_mandatory(self) -> None:
        # Item 3: leaving out any class is a usage error (exit 2), never a shorter run that passes.
        # The usage error must name the omitted flag, so a class that is quietly optional is caught too.
        denied = denied_directory(self.tmp.name)
        self.addCleanup(os.chmod, denied, 0o755)
        with Listener() as control:
            full = argv_pairs(control, closed_loopback_port(), denied)
            for flag in ("--gateway", "--gateway-control-port", "--peer-port", "--host-port", "--estate",
                         "--spool-address", "--spool-port", "--file-path", "--ipv6-route", "--udp-control",
                         "--dns-resolver",
                         "--expect-uid"):
                with self.subTest(omitted=flag):
                    code, out = run_main(to_argv(without(full, flag)))
                    self.assertEqual(code, 2, out)
                    self.assertIn(f"required: {flag}", out)

    def test_a_port_out_of_range_is_a_usage_error(self) -> None:
        denied = os.path.join(self.tmp.name, "absent")
        pairs = [(flag, "70000" if flag == "--peer-port" else value) for flag, value in argv_pairs(1, 2, denied)]
        code, _ = run_main(to_argv(pairs))
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()

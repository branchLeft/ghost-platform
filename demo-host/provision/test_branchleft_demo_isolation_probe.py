"""Unit tests for branchleft_demo_isolation_probe.py against real loopback sockets, real file modes and
mocked connect errors; see branchleft_demo_isolation_probe.md, "Proof". The directory-permission
case is skipped when the suite runs as root, because root reads every file and the probe refuses root."""

from __future__ import annotations

import contextlib
import errno
import importlib.util
import io
import os
import socket
import sys
import tempfile
import unittest
from collections.abc import Callable
from types import ModuleType
from typing import Any
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "branchleft_demo_isolation_probe.py")


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


def argv_pairs(control: int, closed: int, denied: str, uid: str = "1000") -> list[tuple[str, str]]:
    # Every route class present: the control is the allowed spool port, and it is also the only
    # spool port, so nothing else on the spool is probed.
    return [
        ("--gateway", "127.0.0.1"),
        ("--peer-port", str(closed)),
        ("--host-port", str(closed)),
        ("--estate", f"127.0.0.1:{closed}"),
        ("--spool-address", "127.0.0.1"),
        ("--spool-port", str(control)),
        ("--spool-allowed-port", str(control)),
        ("--file-path", denied),
        ("--expect-uid", uid),
        ("--timeout", "1"),
    ]


def to_argv(pairs: list[tuple[str, str]]) -> list[str]:
    return [item for pair in pairs for item in pair]


def without(pairs: list[tuple[str, str]], flag: str) -> list[tuple[str, str]]:
    return [pair for pair in pairs if pair[0] != flag]


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

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads every file")
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


class RouteBuildTests(unittest.TestCase):
    def test_peer_ports_are_probed_on_loopback_and_the_gateway(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[9303], host_ports=[], estate=[],
            spool_address="172.20.0.1", spool_ports=[], spool_allowed_port=0,
        )
        hosts = sorted((route.host, route.port) for route in routes if "slot B" in route.label)
        self.assertEqual(hosts, [("127.0.0.1", 9303), ("172.20.0.1", 9303)])

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


class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        # The public routes depend on the sandbox's internet; the main tests do not need them.
        patcher = mock.patch.object(probe, "PUBLIC_ROUTES", ())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads every file")
    def test_all_refused_exits_zero_and_prints_one_line_per_route(self) -> None:
        denied = denied_directory(self.tmp.name)
        self.addCleanup(os.chmod, denied, 0o755)
        with Listener() as control:
            code, out = run_main(to_argv(argv_pairs(control, closed_loopback_port(), denied)))
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
        self.assertNotIn("REFUSED", out)

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

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads every file")
    def test_each_route_class_is_mandatory(self) -> None:
        # Item 3: leaving out any class is a usage error (exit 2), never a shorter run that passes.
        # Every route is a real refusal, so an omitted class can only pass by being silently dropped.
        denied = denied_directory(self.tmp.name)
        self.addCleanup(os.chmod, denied, 0o755)
        with Listener() as control:
            full = argv_pairs(control, closed_loopback_port(), denied)
            for flag in ("--gateway", "--peer-port", "--host-port", "--estate", "--spool-address",
                         "--spool-port", "--file-path", "--expect-uid"):
                with self.subTest(omitted=flag):
                    code, out = run_main(to_argv(without(full, flag)))
                    self.assertEqual(code, 2, out)

    def test_a_port_out_of_range_is_a_usage_error(self) -> None:
        denied = os.path.join(self.tmp.name, "absent")
        pairs = [(flag, "70000" if flag == "--peer-port" else value) for flag, value in argv_pairs(1, 2, denied)]
        code, _ = run_main(to_argv(pairs))
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()

"""Unit tests for branchleft_demo_isolation_probe.py against real loopback sockets and real file modes.

See branchleft_demo_isolation_probe.md, "Proof". Path cases that depend on file modes are skipped
when the suite runs as root, because root reads every file and the probe itself refuses root."""

from __future__ import annotations

import contextlib
import importlib.util
from collections.abc import Callable
import io
import os
import socket
import stat
import sys
import tempfile
import unittest
from types import ModuleType
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
        except SystemExit as exit_request:  # argparse exits itself on a bad argument
            code = int(exit_request.code or 0)
    return code, out.getvalue()


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

    def test_a_route_that_times_out_is_refused(self) -> None:
        # 10.255.255.1 is unroutable in every sandbox this runs in; a dropped SYN times out.
        outcome = probe.probe_tcp(probe.TcpRoute("dropped", "10.255.255.1", 9), timeout=0.2)
        self.assertEqual(outcome.verdict, "REFUSED")


class PathRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads every file")
    def test_a_directory_with_no_mode_bits_is_refused(self) -> None:
        target = os.path.join(self.tmp.name, "slot")
        os.mkdir(target)
        os.chmod(target, 0o000)
        self.addCleanup(os.chmod, target, 0o755)
        outcome = probe.probe_path(probe.PathRoute("slot dir", target))
        self.assertEqual(outcome.verdict, "REFUSED")

    def test_a_readable_directory_is_reached(self) -> None:
        # The sabotage control: open the slot directory's mode and the file route must report REACHED.
        target = os.path.join(self.tmp.name, "slot")
        os.mkdir(target)
        os.chmod(target, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP)
        outcome = probe.probe_path(probe.PathRoute("slot dir", target))
        self.assertEqual(outcome.verdict, "REACHED")

    def test_a_missing_path_is_unchecked_not_refused(self) -> None:
        # A path that does not exist proves nothing, so it must not count as a refusal.
        missing = os.path.join(self.tmp.name, "no-such-path")
        outcome = probe.probe_path(probe.PathRoute("gone", missing))
        self.assertEqual(outcome.verdict, "UNCHECKED")


class RouteBuildTests(unittest.TestCase):
    def test_peer_ports_are_probed_on_loopback_and_the_gateway(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[9303], host_ports=[], estate=[],
            spool_address=None, spool_ports=[], spool_allowed_port=None,
        )
        hosts = sorted((route.host, route.port) for route in routes if "slot B" in route.label)
        self.assertEqual(hosts, [("127.0.0.1", 9303), ("172.20.0.1", 9303)])

    def test_the_public_routes_are_always_present(self) -> None:
        routes = probe.tcp_routes(
            gateway="172.20.0.1", peer_ports=[], host_ports=[], estate=[],
            spool_address=None, spool_ports=[], spool_allowed_port=None,
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
        # The public routes depend on the sandbox's internet; the probe tests do not need them.
        patcher = mock.patch.object(probe, "PUBLIC_ROUTES", ())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_all_refused_exits_zero_and_prints_one_line_per_route(self) -> None:
        port = closed_loopback_port()
        code, out = run_main(["--gateway", "127.0.0.1", "--peer-port", str(port), "--timeout", "1"])
        self.assertEqual(code, 0, out)
        self.assertIn("REFUSED slot B port", out)
        self.assertNotIn("REACHED", out)

    def test_a_reached_route_exits_non_zero(self) -> None:
        with Listener() as port:
            code, out = run_main(["--gateway", "127.0.0.1", "--peer-port", str(port), "--timeout", "1"])
        self.assertEqual(code, 1)
        self.assertIn("REACHED slot B port", out)

    def test_no_routes_checked_is_refused_not_passed(self) -> None:
        code, _ = run_main(["--gateway", "127.0.0.1", "--timeout", "1", "--file-path", "/nonexistent-4045"])
        self.assertEqual(code, 2)

    def test_root_is_refused_and_nothing_is_probed(self) -> None:
        code, out = run_main(["--gateway", "127.0.0.1", "--timeout", "1"], geteuid=lambda: 0)
        self.assertEqual(code, 2)
        self.assertIn("root", out.lower())
        self.assertNotIn("REFUSED", out)

    def test_a_different_uid_than_expected_is_refused(self) -> None:
        # A closed port gives the run something to pass on, so only the uid check can refuse it.
        port = closed_loopback_port()
        code, out = run_main(["--gateway", "127.0.0.1", "--peer-port", str(port), "--timeout", "1",
                              "--expect-uid", "1234"], geteuid=lambda: 1000)
        self.assertEqual(code, 2)
        self.assertNotIn("REFUSED", out)

    def test_the_expected_uid_runs(self) -> None:
        port = closed_loopback_port()
        code, _ = run_main(["--gateway", "127.0.0.1", "--peer-port", str(port), "--timeout", "1",
                            "--expect-uid", "1000"], geteuid=lambda: 1000)
        self.assertEqual(code, 0)

    def test_a_port_out_of_range_is_a_usage_error(self) -> None:
        code, _ = run_main(["--gateway", "127.0.0.1", "--peer-port", "70000"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()

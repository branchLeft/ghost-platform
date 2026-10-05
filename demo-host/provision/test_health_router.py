#!/usr/bin/env python3
"""Tests for health_router, over real unix sockets and real loopback HTTP.

A fake sidecar listens on a unix socket in a temporary tree with the real
directory modes; the router is started on an OS-chosen loopback port and
asked the way Caddy asks. Ownership is the test runner's own uid, and a
foreign owner is simulated by telling the router to expect another uid.
"""

from __future__ import annotations

import contextlib
import http.client
import http.server
import os
import shutil
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import health_router as hr
import render_demo_edge as rde
import render_router_unit as rru
import render_slot_sudoers as rss

ME = os.getuid()
SLOT = "3"


class _UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class FakeSidecar:
    """Answers GET /healthz on a unix socket with a settable status."""

    def __init__(self, path: str, status: int = 200, hang: bool = False):
        self.status = status
        self.hang = hang
        self.requests = 0
        self.release = threading.Event()
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.requests += 1
                if outer.hang:
                    outer.release.wait(10)
                try:
                    self.send_response(outer.status)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"{}")
                except OSError:
                    pass

            def log_message(self, *args):
                return

        self.server = _UnixHTTPServer(path, Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


def make_tree(root: str, slot: str = SLOT, colours=("a", "b")) -> None:
    for sub in (slot, *(f"{slot}/{c}" for c in colours)):
        path = os.path.join(root, sub)
        os.makedirs(path, exist_ok=True)
        os.chmod(path, 0o700)


class _Case(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="hr", dir="/tmp")
        os.chmod(self.base, 0o755)
        self.addCleanup(shutil.rmtree, self.base, True)
        self.root = os.path.join(self.base, "demo-router")
        os.mkdir(self.root, 0o755)
        self.sidecars: list[FakeSidecar] = []
        self.addCleanup(self._close_sidecars)

    def _close_sidecars(self):
        for sidecar in self.sidecars:
            sidecar.close()

    def sidecar(self, colour: str, **kwargs) -> FakeSidecar:
        make_tree(self.root)
        car = FakeSidecar(hr.socket_path(self.root, SLOT, colour), **kwargs)
        self.sidecars.append(car)
        return car

    def start_router(self, owner_uid: int = ME) -> int:
        server = hr.make_server(SLOT, root=self.root, owner_uid=owner_uid, port=0)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        return server.server_address[1]

    def ask(self, port: int, colour: str | None = "a", *, headers=None, path="/healthz") -> int:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        sent = dict(headers or {})
        if colour is not None:
            sent[hr.COLOUR_HEADER] = f"127.0.0.1:{hr.slot_app_port(SLOT, colour)}"
        conn.request("GET", path, headers=sent)
        status = conn.getresponse().status
        conn.close()
        return status


class ColourSelectionTests(_Case):
    def test_each_colour_is_answered_from_its_own_sidecar(self):
        a, b = self.sidecar("a", status=200), self.sidecar("b", status=503)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 200)
        self.assertEqual(self.ask(port, "b"), 503)
        self.assertEqual((a.requests, b.requests), (1, 1))

    def test_both_directions_of_a_swap(self):
        a, b = self.sidecar("a", status=503), self.sidecar("b", status=200)
        port = self.start_router()
        self.assertEqual((self.ask(port, "a"), self.ask(port, "b")), (503, 200))
        a.status, b.status = 200, 503
        self.assertEqual((self.ask(port, "a"), self.ask(port, "b")), (200, 503))

    def test_colour_a_check_never_reaches_colour_bs_socket(self):
        self.sidecar("a", status=503)
        b = self.sidecar("b", status=200)
        port = self.start_router()
        for _ in range(3):
            self.assertEqual(self.ask(port, "a"), 503)
        self.assertEqual(b.requests, 0)

    def test_colour_b_check_never_reaches_colour_as_socket(self):
        a = self.sidecar("a", status=200)
        self.sidecar("b", status=503)
        port = self.start_router()
        self.assertEqual(self.ask(port, "b"), 503)
        self.assertEqual(a.requests, 0)

    def test_header_text_never_becomes_a_path(self):
        a = self.sidecar("a", status=200)
        b = self.sidecar("b", status=200)
        port = self.start_router()
        for value in (
            "127.0.0.1:9306/../b",
            "../b",
            "b",
            "a",
            "127.0.0.1:9306,127.0.0.1:9307",
            "127.0.0.1:9300",
            "localhost:9306",
        ):
            status = self.ask(port, None, headers={hr.COLOUR_HEADER: value})
            self.assertEqual(status, 503, value)
        self.assertEqual((a.requests, b.requests), (0, 0))

    def test_no_header_is_refused(self):
        self.sidecar("a")
        port = self.start_router()
        self.assertEqual(self.ask(port, None), 503)

    def test_two_headers_are_refused(self):
        a = self.sidecar("a")
        port = self.start_router()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.putrequest("GET", "/healthz")
        conn.putheader(hr.COLOUR_HEADER, "127.0.0.1:9306")
        conn.putheader(hr.COLOUR_HEADER, "127.0.0.1:9307")
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 503)
        self.assertEqual(a.requests, 0)

    def test_other_paths_are_not_found(self):
        self.sidecar("a")
        port = self.start_router()
        self.assertEqual(self.ask(port, "a", path="/metrics"), 404)

    def test_only_get_is_served(self):
        self.sidecar("a")
        port = self.start_router()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/healthz", headers={hr.COLOUR_HEADER: "127.0.0.1:9306"})
        self.assertEqual(conn.getresponse().status, 501)


class FailClosedTests(_Case):
    def test_missing_socket_is_503(self):
        make_tree(self.root)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 503)

    def test_missing_tree_is_503(self):
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 503)

    def test_stopped_sidecar_leaves_a_stale_socket_that_is_503(self):
        car = self.sidecar("a", status=200)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 200)
        car.server.shutdown()
        car.server.socket.close()
        self.assertTrue(os.path.exists(hr.socket_path(self.root, SLOT, "a")))
        self.assertEqual(self.ask(port, "a"), 503)

    def test_socket_removed_after_start_is_503_on_the_next_check(self):
        self.sidecar("a", status=200)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 200)
        os.unlink(hr.socket_path(self.root, SLOT, "a"))
        self.assertEqual(self.ask(port, "a"), 503)

    def test_hung_sidecar_is_503_within_the_timeout(self):
        self.sidecar("a", hang=True)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 503)

    def test_sidecar_that_is_not_http_is_503(self):
        make_tree(self.root)
        path = hr.socket_path(self.root, SLOT, "a")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(4)
        self.addCleanup(listener.close)

        def serve():
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                conn.sendall(b"nonsense\r\n")
                conn.close()

        threading.Thread(target=serve, daemon=True).start()
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 503)

    def test_every_non_200_sidecar_answer_is_503(self):
        car = self.sidecar("a")
        port = self.start_router()
        for status in (204, 301, 404, 500, 503):
            with self.subTest(status=status):
                car.status = status
                self.assertEqual(self.ask(port, "a"), 503)


class SocketDirectoryTests(_Case):
    def test_wrong_slot_directory_mode_is_refused(self):
        self.sidecar("a", status=200)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 200)
        os.chmod(os.path.join(self.root, SLOT), 0o755)
        self.assertEqual(self.ask(port, "a"), 503)

    def test_wrong_colour_directory_mode_is_refused(self):
        self.sidecar("a", status=200)
        port = self.start_router()
        os.chmod(os.path.join(self.root, SLOT, "a"), 0o750)
        self.assertEqual(self.ask(port, "a"), 503)

    def test_every_non_0700_mode_is_refused(self):
        self.sidecar("a")
        for mode in (0o755, 0o750, 0o770, 0o777, 0o701, 0o500, 0o600):
            with self.subTest(mode=oct(mode)):
                os.chmod(os.path.join(self.root, SLOT), mode)
                with self.assertRaises(hr.SocketRefused):
                    hr.verify_socket(self.root, SLOT, "a", ME)
        os.chmod(os.path.join(self.root, SLOT), 0o700)
        hr.verify_socket(self.root, SLOT, "a", ME)

    def test_wrong_owner_is_refused(self):
        self.sidecar("a", status=200)
        port = self.start_router(owner_uid=ME + 1)
        self.assertEqual(self.ask(port, "a"), 503)
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME + 1)

    def test_correct_owner_is_accepted(self):
        self.sidecar("a", status=200)
        self.assertTrue(hr.verify_socket(self.root, SLOT, "a", ME).endswith("3/a/health.sock"))

    def test_a_symlinked_slot_directory_is_refused(self):
        make_tree(self.root, slot="4")
        real = os.path.join(self.root, "4")
        shutil.rmtree(os.path.join(self.root, SLOT), ignore_errors=True)
        os.symlink(real, os.path.join(self.root, SLOT))
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_regular_file_in_place_of_the_socket_is_refused(self):
        make_tree(self.root)
        Path(hr.socket_path(self.root, SLOT, "a")).write_text("")
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_symlink_in_place_of_the_socket_is_refused(self):
        car = self.sidecar("b", status=200)
        link = hr.socket_path(self.root, SLOT, "a")
        os.symlink(hr.socket_path(self.root, SLOT, "b"), link)
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME)
        port = self.start_router()
        self.assertEqual(self.ask(port, "a"), 503)
        self.assertEqual(car.requests, 0)

    def test_a_root_others_can_write_is_refused(self):
        self.sidecar("a")
        os.chmod(self.root, 0o777)
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_root_owned_by_someone_else_is_refused(self):
        self.sidecar("a")
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME + 1)

    def _owned_by_someone_else(self, victim: str):
        """Makes the router see `victim` (whatever way it reaches it) as owned
        by another uid, keyed on the directory entry's identity."""
        target = os.lstat(victim)
        real_fstat, real_stat = os.fstat, os.stat

        def other(st):
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, ME + 1, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime))  # fmt: skip

        def same(st):
            return (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino)

        def fstat(fd):
            st = real_fstat(fd)
            return other(st) if same(st) else st

        def stat_(path, *args, **kwargs):
            st = real_stat(path, *args, **kwargs)
            return other(st) if same(st) else st

        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(hr.os, "fstat", fstat))
        stack.enter_context(mock.patch.object(hr.os, "stat", stat_))
        return stack

    def test_a_slot_directory_owned_by_someone_else_is_refused(self):
        self.sidecar("a")
        with self._owned_by_someone_else(os.path.join(self.root, SLOT)):
            with self.assertRaises(hr.SocketRefused):
                hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_colour_directory_owned_by_someone_else_is_refused(self):
        self.sidecar("a")
        with self._owned_by_someone_else(os.path.join(self.root, SLOT, "a")):
            with self.assertRaises(hr.SocketRefused):
                hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_socket_owned_by_someone_else_is_refused(self):
        self.sidecar("a")
        with self._owned_by_someone_else(hr.socket_path(self.root, SLOT, "a")):
            with self.assertRaises(hr.SocketRefused):
                hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_root_directory_owned_by_someone_else_is_refused(self):
        self.sidecar("a")
        with self._owned_by_someone_else(self.root):
            with self.assertRaises(hr.SocketRefused):
                hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_parent_directory_owned_by_someone_else_is_refused(self):
        self.sidecar("a")
        with self._owned_by_someone_else(self.base):
            with self.assertRaises(hr.SocketRefused):
                hr.verify_socket(self.root, SLOT, "a", ME)

    def test_a_parent_directory_others_can_write_is_refused(self):
        self.sidecar("a")
        for mode in (0o775, 0o757, 0o777):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.base, mode)
                with self.assertRaises(hr.SocketRefused):
                    hr.verify_socket(self.root, SLOT, "a", ME)
                port = self.start_router()
                self.assertEqual(self.ask(port, "a"), 503)

    def test_a_symlinked_parent_entry_for_the_root_is_refused(self):
        self.sidecar("a")
        moved = os.path.join(self.base, "moved")
        os.rename(self.root, moved)
        os.symlink(moved, self.root)
        with self.assertRaises(hr.SocketRefused):
            hr.verify_socket(self.root, SLOT, "a", ME)

    def test_the_descriptors_are_closed_after_every_check(self):
        self.sidecar("a")
        before = set(os.listdir("/dev/fd"))
        for _ in range(20):
            hr.verify_socket(self.root, SLOT, "a", ME)
            with self.assertRaises(hr.SocketRefused):
                hr.verify_socket(self.root, SLOT, "a", ME + 1)
        self.assertEqual(set(os.listdir("/dev/fd")), before)

    def test_socket_modes_are_not_assumed(self):
        self.sidecar("a")
        mode = stat.S_IMODE(os.lstat(os.path.join(self.root, SLOT)).st_mode)
        self.assertEqual(mode, 0o700)


@unittest.skipUnless(sys.platform == "linux", "the pinned connect resolves through /proc, which only the demo host's Linux has")
class RaceTests(_Case):
    """The check and the connect see one directory, however the tree is
    changed between them. The change is made from inside the router's own
    call to the sidecar, after every check has passed and before the connect,
    which is the window a path-based connect leaves open."""

    def _swap_during_the_window(self, swap):
        real = hr.sidecar_status

        def racing(path, *args, **kwargs):
            swap()
            return real(path, *args, **kwargs)

        return mock.patch.object(hr, "sidecar_status", racing)

    def test_a_renamed_colour_directory_cannot_redirect_the_connect(self):
        sick = self.sidecar("a", status=503)
        well = self.sidecar("b", status=200)
        a_dir = os.path.join(self.root, SLOT, "a")
        b_dir = os.path.join(self.root, SLOT, "b")

        def swap():
            os.rename(a_dir, a_dir + ".aside")
            os.rename(b_dir, a_dir)

        with self._swap_during_the_window(swap):
            status, reason = hr.decide(self.root, SLOT, ME, [f"127.0.0.1:{hr.slot_app_port(SLOT, 'a')}"])
        self.assertEqual(status, 503, reason)
        self.assertEqual((sick.requests, well.requests), (1, 0))

    def test_a_renamed_root_directory_cannot_redirect_the_connect(self):
        sick = self.sidecar("a", status=503)
        well = self.sidecar("b", status=200)
        elsewhere = self.root + ".aside"

        def swap():
            os.rename(self.root, elsewhere)
            os.makedirs(os.path.join(self.root, SLOT))
            os.rename(os.path.join(elsewhere, SLOT, "b"), os.path.join(self.root, SLOT, "a"))

        with self._swap_during_the_window(swap):
            status, reason = hr.decide(self.root, SLOT, ME, [f"127.0.0.1:{hr.slot_app_port(SLOT, 'a')}"])
        self.assertEqual(status, 503, reason)
        self.assertEqual((sick.requests, well.requests), (1, 0))

    def test_a_replaced_slot_directory_cannot_redirect_the_connect(self):
        sick = self.sidecar("a", status=503)
        well = self.sidecar("b", status=200)
        slot_dir = os.path.join(self.root, SLOT)

        def swap():
            os.rename(slot_dir, slot_dir + ".aside")
            os.mkdir(slot_dir, 0o700)
            os.rename(os.path.join(slot_dir + ".aside", "b"), os.path.join(slot_dir, "a"))

        with self._swap_during_the_window(swap):
            status, reason = hr.decide(self.root, SLOT, ME, [f"127.0.0.1:{hr.slot_app_port(SLOT, 'a')}"])
        self.assertEqual(status, 503, reason)
        self.assertEqual((sick.requests, well.requests), (1, 0))


class ContractTests(unittest.TestCase):
    def test_ports_match_the_edge_generator_for_every_slot(self):
        for slot in rss.SLOT_NAMES:
            self.assertEqual(hr.slot_health_port(slot), rde.slot_health_port(slot))
            for colour in hr.COLOURS:
                self.assertEqual(hr.slot_app_port(slot, colour), rde.slot_app_port(slot, colour))

    def test_header_name_address_and_uri_match_the_edge(self):
        self.assertEqual(hr.COLOUR_HEADER, rde.COLOUR_HEADER)
        self.assertEqual(hr.EDGE_ADDR, rde.DEMO_EDGE_ADDR)
        self.assertEqual(hr.HEALTH_URI, rde.HEALTH_URI)
        self.assertEqual((hr.APP_PORT_BASE, hr.HEALTH_PORT_BASE), (rde.APP_PORT_BASE, rde.HEALTH_PORT_BASE))

    def test_slot_and_colour_tables_match_the_wrapper(self):
        self.assertEqual(hr.SLOT_NAMES, rss.SLOT_NAMES)
        self.assertEqual(hr.COLOURS, rss.COLOURS)

    def test_the_header_values_the_edge_sends_are_the_ones_accepted(self):
        for slot in rss.SLOT_NAMES:
            sent = {f"{rde.DEMO_EDGE_ADDR}:{rde.slot_app_port(slot, c)}" for c in ("a", "b")}
            self.assertEqual(set(hr.colour_by_upstream(slot)), sent)

    def test_every_slot_binds_the_edges_health_port_on_loopback(self):
        server = hr.make_server("2", port=0)
        self.addCleanup(server.server_close)
        self.assertEqual(server.server_address[0], "127.0.0.1")
        self.assertEqual(hr.slot_health_port("2"), 9102)

    def test_unknown_slot_is_refused(self):
        with self.assertRaises(ValueError):
            hr.make_server("7", port=0)
        self.assertEqual(hr.main(["--slot", "7"]), 2)

    def test_the_router_never_references_docker(self):
        source = Path(hr.__file__).read_text().lower()
        self.assertNotIn("docker", source)
        self.assertNotIn("subprocess", source)

    def test_the_router_opens_no_port_but_the_slots_health_port(self):
        source = Path(hr.__file__).read_text()
        self.assertEqual(source.count("RouterServer(("), 1)
        self.assertNotIn(".listen(", source)


class UnitTests(unittest.TestCase):
    def setUp(self):
        self.unit = rru.render()

    def test_it_is_a_template_over_the_slot(self):
        self.assertEqual(rru.UNIT_NAME, "branchleft-health-router@.service")
        self.assertIn("--slot %i", self.unit)

    def test_it_runs_as_the_router_account_with_no_extra_groups(self):
        self.assertIn(f"User={hr.ROUTER_USER}\n", self.unit)
        self.assertNotIn("SupplementaryGroups", self.unit)
        self.assertNotIn("User=root", self.unit)

    def test_it_is_not_tied_to_either_colours_lifecycle(self):
        for directive in ("Requires", "Wants", "BindsTo", "PartOf", "Requisite", "Upholds", "After", "Before", "Conflicts", "PropagatesStopTo"):
            self.assertNotRegex(self.unit, rf"(?m)^{directive}=")
        self.assertNotIn("branchleft-compose", self.unit)
        self.assertNotIn("docker.service", self.unit)

    def test_it_restarts_whatever_happens_and_is_enabled_at_boot(self):
        self.assertIn("Restart=always", self.unit)
        self.assertIn("WantedBy=multi-user.target", self.unit)

    def test_it_cannot_see_the_docker_socket_or_leave_loopback(self):
        self.assertIn("-/var/run/docker.sock", self.unit)
        self.assertIn("IPAddressAllow=localhost", self.unit)
        self.assertIn("IPAddressDeny=any", self.unit)
        self.assertIn("RestrictAddressFamilies=AF_INET AF_UNIX", self.unit)

    def test_it_is_hardened(self):
        for line in ("NoNewPrivileges=yes", "ProtectSystem=strict", "CapabilityBoundingSet=\n", "PrivateTmp=yes"):
            self.assertIn(line, self.unit)

    def test_the_script_path_is_the_one_documented(self):
        self.assertIn(f"ExecStart=/usr/bin/python3 {rru.ROUTER_SCRIPT} --slot %i", self.unit)

    def test_install_writes_one_file_with_the_unit_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            if os.geteuid() != 0:
                self.skipTest("install chowns to root")
            path = rru.install(tmp)
            self.assertEqual(Path(path).read_text(), self.unit)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), rru.UNIT_MODE)


if __name__ == "__main__":
    unittest.main()

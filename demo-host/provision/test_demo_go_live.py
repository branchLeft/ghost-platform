#!/usr/bin/env python3
"""Unit tests for demo_go_live: a stand-in loaded anywhere refuses, and a
refusal writes nothing."""

from __future__ import annotations

import contextlib
import http.server
import io
import json
import os
import pathlib
import stat
import tempfile
import threading
import unittest

import demo_go_live as dgl

CLEAN = {"slot": "0", "phase": "running", "healthy": True, "notReal": [], "interim": []}


def serve(**per_slot):
    def fetch(_url, slot):
        value = per_slot.get(slot, CLEAN)
        if isinstance(value, Exception):
            raise value
        return value
    return fetch


class GoLiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = pathlib.Path(self.tmp.name, "Caddyfile.rendered")
        self.src.write_text("rendered\n", encoding="utf-8")
        self.dest = pathlib.Path(self.tmp.name, "Caddyfile")

    def attempt(self, fetch, clock=lambda: True):
        dgl.go_live("http://broker.invalid", str(self.src), str(self.dest), fetch=fetch, clock=clock)

    def test_clean_broker_opens_the_demo(self):
        self.attempt(serve())
        self.assertEqual(self.dest.read_text(encoding="utf-8"), "rendered\n")

    def test_a_stand_in_refuses_and_writes_nothing(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "noop-admin-api"):
            self.attempt(serve(**{"0": {**CLEAN, "notReal": ["noop-admin-api"]}}))
        self.assertFalse(self.dest.exists())

    def test_a_stand_in_on_any_slot_refuses(self):
        for slot in dgl.SLOT_NAMES:
            with self.subTest(slot=slot):
                with self.assertRaises(dgl.GoLiveRefused):
                    self.attempt(serve(**{slot: {**CLEAN, "notReal": ["drainSource"]}}))
                self.assertFalse(self.dest.exists())

    def test_an_interim_module_refuses(self):
        with self.assertRaises(dgl.GoLiveRefused):
            self.attempt(serve(**{"3": {**CLEAN, "interim": ["adminApi"]}}))

    def test_unreachable_broker_refuses(self):
        with self.assertRaises(dgl.GoLiveRefused):
            self.attempt(serve(**{"0": OSError("down")}))
        self.assertFalse(self.dest.exists())

    def test_status_without_the_lists_refuses(self):
        for body in ({}, {"slot": "0"}, {"notReal": []}, {"interim": []}, {"notReal": "x", "interim": []}, [], "ok"):
            with self.subTest(body=body):
                with self.assertRaises(dgl.GoLiveRefused):
                    self.attempt(serve(**{"0": body}))

    def test_unsynchronised_clock_refuses_and_writes_nothing(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "clock"):
            self.attempt(serve(), clock=lambda: False)
        self.assertFalse(self.dest.exists())

    def test_refusal_leaves_a_previous_file_untouched(self):
        self.dest.write_text("old\n", encoding="utf-8")
        with self.assertRaises(dgl.GoLiveRefused):
            self.attempt(serve(**{"0": {**CLEAN, "notReal": ["x"]}}))
        self.assertEqual(self.dest.read_text(encoding="utf-8"), "old\n")

    def run_cli(self, status):
        fetch, clock = dgl.fetch_status, dgl.clock_is_synchronised
        dgl.fetch_status = lambda _u, _s: status
        dgl.clock_is_synchronised = lambda: True
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                code = dgl.main(["--broker-url", "http://x", "--caddyfile", str(self.src), "--install", str(self.dest)])
        finally:
            dgl.fetch_status, dgl.clock_is_synchronised = fetch, clock
        return code, stderr.getvalue()

    def test_cli_refuses_a_stand_in_with_a_nonzero_exit_and_the_reason(self):
        code, stderr = self.run_cli({**CLEAN, "notReal": ["noop-drain-source"]})
        self.assertNotEqual(code, 0)
        self.assertIn("noop-drain-source", stderr)
        self.assertFalse(self.dest.exists())

    def test_cli_control_a_clean_broker_exits_zero(self):
        code, _ = self.run_cli(CLEAN)
        self.assertEqual(code, 0)
        self.assertTrue(self.dest.exists())


def broker_body(slot, not_real=(), interim=()):
    """The body `services/broker/src/app.ts` `handleStatus` sends: slot, phase,
    healthy, then the two seam lists from `seamReadiness.ts`."""
    return {"slot": slot, "phase": "running", "healthy": True, "notReal": list(not_real), "interim": list(interim)}


class FakeBroker:
    """A real HTTP listener on loopback serving the broker's `/status/<slot>`
    body, so `fetch_status` runs for real: sockets, status line, JSON parse."""

    def __init__(self, bodies, status=200):
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                slot = self.path.rsplit("/", 1)[-1]
                outer.requested.append(self.path)
                if slot not in bodies:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(bodies[slot]).encode())

            def log_message(self, *_args):
                pass

        self.requested = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def clean_bodies():
    return {slot: broker_body(slot) for slot in dgl.SLOT_NAMES}


class FetchStatusTests(unittest.TestCase):
    """`fetch_status` against a real listener."""

    def start(self, bodies, status=200):
        broker = FakeBroker(bodies, status)
        self.addCleanup(broker.close)
        return broker

    def test_returns_the_brokers_body_untouched(self):
        broker = self.start(clean_bodies())
        self.assertEqual(dgl.fetch_status(broker.url, "2"), broker_body("2"))
        self.assertEqual(broker.requested, ["/status/2"])

    def test_stand_in_lists_reach_the_caller(self):
        bodies = clean_bodies()
        bodies["4"] = broker_body("4", not_real=["adminApi", "drainSource"], interim=["x"])
        broker = self.start(bodies)
        status = dgl.fetch_status(broker.url, "4")
        self.assertEqual(status["notReal"], ["adminApi", "drainSource"])
        self.assertEqual(status["interim"], ["x"])

    def test_a_non_2xx_is_an_error(self):
        broker = self.start(clean_bodies(), status=500)
        with self.assertRaises(Exception):
            dgl.fetch_status(broker.url, "0")

    def test_go_live_end_to_end_refuses_a_stand_in_over_real_http(self):
        bodies = clean_bodies()
        bodies["5"] = broker_body("5", not_real=["noop-admin-api"])
        broker = self.start(bodies)
        with self.assertRaisesRegex(dgl.GoLiveRefused, "noop-admin-api"):
            dgl.check_seams(broker.url)
        self.assertEqual(broker.requested[-1], "/status/5")

    def test_go_live_end_to_end_control_clean_broker_passes(self):
        broker = self.start(clean_bodies())
        dgl.check_seams(broker.url)
        self.assertEqual(len(broker.requested), len(dgl.SLOT_NAMES))

    def test_a_dead_broker_is_a_refusal(self):
        broker = self.start(clean_bodies())
        url = broker.url
        broker.close()
        with self.assertRaises(dgl.GoLiveRefused):
            dgl.check_seams(url)


class ClockReaderTests(unittest.TestCase):
    """`clock_is_synchronised` against a stub `timedatectl` first on PATH.
    `show -p NTPSynchronized --value` prints `yes` or `no` and a newline."""

    def stub(self, script):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        if script is not None:
            path = pathlib.Path(directory.name, "timedatectl")
            path.write_text("#!/bin/sh\n" + script, encoding="utf-8")
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        previous = os.environ["PATH"]
        os.environ["PATH"] = directory.name  # only the stub, or nothing
        self.addCleanup(os.environ.__setitem__, "PATH", previous)

    def test_yes_is_synchronised(self):
        self.stub('[ "$*" = "show -p NTPSynchronized --value" ] || exit 9\necho yes\n')
        self.assertTrue(dgl.clock_is_synchronised())

    def test_no_is_not_synchronised(self):
        self.stub("echo no\n")
        self.assertFalse(dgl.clock_is_synchronised())

    def test_a_non_zero_exit_is_not_synchronised_even_if_it_printed_yes(self):
        self.stub("echo yes\nexit 1\n")
        self.assertFalse(dgl.clock_is_synchronised())

    def test_anything_but_exactly_yes_is_not_synchronised(self):
        for output in ("", "YES", "yes-ish", "n/a"):
            with self.subTest(output=output):
                self.stub(f"printf '%s' '{output}'\n")
                self.assertFalse(dgl.clock_is_synchronised())

    def test_a_missing_timedatectl_is_not_synchronised(self):
        self.stub(None)
        self.assertFalse(dgl.clock_is_synchronised())


if __name__ == "__main__":
    unittest.main()

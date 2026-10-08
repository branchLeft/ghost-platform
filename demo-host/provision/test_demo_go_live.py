#!/usr/bin/env python3
"""Unit tests for demo_go_live: a stand-in loaded anywhere refuses, and a
refusal writes nothing."""

from __future__ import annotations

import contextlib
import io
import pathlib
import tempfile
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


if __name__ == "__main__":
    unittest.main()

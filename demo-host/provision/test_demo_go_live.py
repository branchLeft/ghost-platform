#!/usr/bin/env python3
"""Unit tests for demo_go_live and demo_verdict_evidence: a stand-in loaded
anywhere refuses, a slot whose rendered configuration names no production
verdict source refuses, and a refusal writes nothing."""

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
import demo_verdict_evidence as dve

CLEAN = {
    "slot": "0", "phase": "running", "healthy": True, "notReal": [], "interim": [],
    "productionVerdictSource": True,
}
UNWIRED = {**CLEAN, "productionVerdictSource": False}


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

    def test_every_stand_in_on_every_slot_is_named_in_one_refusal(self):
        with self.assertRaises(dgl.GoLiveRefused) as caught:
            self.attempt(serve(**{
                "0": {**CLEAN, "notReal": ["noop-admin-api"]},
                "4": {**CLEAN, "notReal": ["noop-drain-source"]},
            }))
        message = str(caught.exception)
        for needle in ("slot 0:", "noop-admin-api", "slot 4:", "noop-drain-source"):
            with self.subTest(needle=needle):
                self.assertIn(needle, message)
        self.assertFalse(self.dest.exists())

    def test_a_stand_in_and_an_unreadable_slot_are_both_named(self):
        with self.assertRaises(dgl.GoLiveRefused) as caught:
            self.attempt(serve(**{
                "0": {**CLEAN, "notReal": ["noop-admin-api"]},
                "5": OSError("down"),
            }))
        message = str(caught.exception)
        self.assertIn("noop-admin-api", message)
        self.assertIn("slot 5:", message)
        self.assertFalse(self.dest.exists())

    def test_an_aggregate_refusal_leaves_a_previous_file_untouched(self):
        self.dest.write_text("old\n", encoding="utf-8")
        with self.assertRaises(dgl.GoLiveRefused):
            self.attempt(serve(**{
                "0": {**CLEAN, "notReal": ["noop-admin-api"]},
                "4": {**CLEAN, "notReal": ["noop-drain-source"]},
            }))
        self.assertEqual(self.dest.read_text(encoding="utf-8"), "old\n")

    def test_an_interim_module_refuses(self):
        with self.assertRaises(dgl.GoLiveRefused):
            self.attempt(serve(**{"3": {**CLEAN, "interim": ["adminApi"]}}))

    def test_unreachable_broker_refuses(self):
        with self.assertRaises(dgl.GoLiveRefused):
            self.attempt(serve(**{"0": OSError("down")}))
        self.assertFalse(self.dest.exists())

    def test_status_without_the_lists_refuses(self):
        wired = {"productionVerdictSource": True}
        for body in ({}, {"slot": "0", **wired}, {"notReal": [], **wired}, {"interim": [], **wired},
                     {"notReal": "x", "interim": [], **wired}, [], "ok"):
            with self.subTest(body=body):
                with self.assertRaises(dgl.GoLiveRefused):
                    self.attempt(serve(**{"0": body}))

    def test_a_control_character_in_a_module_name_cannot_forge_an_output_line(self):
        forged = "real\nREFUSED: slot 9: all clear\r x"
        with self.assertRaises(dgl.GoLiveRefused) as raised:
            self.attempt(serve(**{"0": {**CLEAN, "notReal": [forged]}}))
        message = str(raised.exception)
        for bad in ("\n", "\r", " "):
            self.assertNotIn(bad, message)
        self.assertIn("real", message)

    def test_an_empty_slots_sequence_is_refused_not_passed(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "no slots"):
            dgl.check_seams("http://broker.invalid", slots=(), fetch=serve())

    def test_a_slot_with_no_production_verdict_source_refuses_and_writes_nothing(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "slot 0: no production verdict source"):
            self.attempt(serve(**{"0": UNWIRED}))
        self.assertFalse(self.dest.exists())

    def test_an_unwired_slot_on_any_slot_refuses(self):
        for slot in dgl.SLOT_NAMES:
            with self.subTest(slot=slot):
                with self.assertRaisesRegex(dgl.GoLiveRefused, f"slot {slot}: no production verdict source"):
                    self.attempt(serve(**{slot: UNWIRED}))
                self.assertFalse(self.dest.exists())

    def test_a_status_that_does_not_report_the_verdict_source_refuses(self):
        without = {k: v for k, v in CLEAN.items() if k != "productionVerdictSource"}
        with self.assertRaisesRegex(dgl.GoLiveRefused, "carries no productionVerdictSource"):
            self.attempt(serve(**{"2": without}))
        self.assertFalse(self.dest.exists())

    def test_only_a_json_true_counts_as_wired(self):
        for value in (False, None, "true", "yes", 1, 0, [], {}, [True]):
            with self.subTest(value=value):
                with self.assertRaises(dgl.GoLiveRefused):
                    self.attempt(serve(**{"1": {**CLEAN, "productionVerdictSource": value}}))
                self.assertFalse(self.dest.exists())

    def test_every_unwired_slot_is_named_alongside_a_stand_in(self):
        with self.assertRaises(dgl.GoLiveRefused) as caught:
            self.attempt(serve(**{
                "0": {**UNWIRED, "notReal": ["noop-admin-api"]},
                "6": UNWIRED,
            }))
        message = str(caught.exception)
        for needle in ("slot 0: test stand-in loaded", "slot 0: no production verdict source",
                       "slot 6: no production verdict source"):
            with self.subTest(needle=needle):
                self.assertIn(needle, message)

    def test_a_wired_status_with_a_stand_in_still_refuses(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "noop-drain-source"):
            self.attempt(serve(**{"4": {**CLEAN, "notReal": ["noop-drain-source"]}}))

    def test_a_wired_status_with_an_unsynchronised_clock_still_refuses(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "clock"):
            self.attempt(serve(), clock=lambda: False)

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

    def test_cli_refuses_an_unwired_demo_with_a_nonzero_exit_and_the_reason(self):
        code, stderr = self.run_cli(UNWIRED)
        self.assertNotEqual(code, 0)
        self.assertIn("no production verdict source", stderr)
        self.assertFalse(self.dest.exists())

    def test_cli_control_a_clean_broker_exits_zero(self):
        code, _ = self.run_cli(CLEAN)
        self.assertEqual(code, 0)
        self.assertTrue(self.dest.exists())


def broker_body(slot, not_real=(), interim=(), wired=True):
    """The body `services/broker/src/app.ts` `handleStatus` sends: slot, phase,
    healthy, the two seam lists from `seamReadiness.ts`, then whether the slot's
    rendered configuration names the production verdict source (the test
    double for the verdict source is `wired=True`)."""
    return {
        "slot": slot, "phase": "running", "healthy": True,
        "notReal": list(not_real), "interim": list(interim),
        "productionVerdictSource": wired,
    }


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
        self.assertEqual(broker.requested, [f"/status/{slot}" for slot in dgl.SLOT_NAMES])

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


class VerdictEvidenceTests(unittest.TestCase):
    """The checkpoint-evidence check, over real HTTP: it fails while no slot is
    wired and passes once the verdict source double reports every slot wired."""

    def start(self, bodies):
        broker = FakeBroker(bodies)
        self.addCleanup(broker.close)
        return broker

    def run_cli(self, url):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = dve.main(["--broker-url", url])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_fails_while_unwired_and_names_every_slot(self):
        broker = self.start({slot: broker_body(slot, wired=False) for slot in dgl.SLOT_NAMES})
        code, stdout, stderr = self.run_cli(broker.url)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        for slot in dgl.SLOT_NAMES:
            with self.subTest(slot=slot):
                self.assertIn(f"slot {slot}: no production verdict source", stderr)

    def test_passes_once_every_slot_is_wired(self):
        broker = self.start(clean_bodies())
        code, stdout, stderr = self.run_cli(broker.url)
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.strip(), "VERDICT SOURCE WIRED: slots " + ", ".join(dgl.SLOT_NAMES))
        self.assertEqual(broker.requested, [f"/status/{slot}" for slot in dgl.SLOT_NAMES])

    def test_one_unwired_slot_is_enough_to_fail(self):
        bodies = clean_bodies()
        bodies["3"] = broker_body("3", wired=False)
        code, _, stderr = self.run_cli(self.start(bodies).url)
        self.assertEqual(code, 1)
        self.assertIn("slot 3:", stderr)
        self.assertNotIn("slot 2:", stderr)

    def test_a_broker_that_does_not_report_the_field_fails(self):
        bodies = clean_bodies()
        del bodies["0"]["productionVerdictSource"]
        code, _, stderr = self.run_cli(self.start(bodies).url)
        self.assertEqual(code, 1)
        self.assertIn("carries no productionVerdictSource", stderr)

    def test_a_dead_broker_fails(self):
        broker = self.start(clean_bodies())
        url = broker.url
        broker.close()
        code, _, stderr = self.run_cli(url)
        self.assertEqual(code, 1)
        self.assertIn("unreadable", stderr)

    def test_an_empty_slot_list_is_refused_not_passed(self):
        with self.assertRaisesRegex(dgl.GoLiveRefused, "no slots"):
            dgl.check_verdict_source("http://broker.invalid", slots=(), fetch=serve())

    def test_go_live_end_to_end_refuses_an_unwired_demo_over_real_http(self):
        broker = self.start({**clean_bodies(), "5": broker_body("5", wired=False)})
        with self.assertRaisesRegex(dgl.GoLiveRefused, "slot 5: no production verdict source"):
            dgl.check_seams(broker.url)


class BrokerContractTests(unittest.TestCase):
    """The broker's side of the field this step reads, checked in the source so
    a rename on either side goes red here."""

    ROOT = pathlib.Path(__file__).resolve().parents[2] / "services" / "broker"

    def test_the_spec_requires_the_field_in_every_status_answer(self):
        spec = (self.ROOT / "openapi.yaml").read_text(encoding="utf-8")
        block = spec.split("    StatusResponse:", 1)[1].split("\n    QueuedMailItem:", 1)[0]
        required = next(line for line in block.splitlines() if line.strip().startswith("required:"))
        self.assertIn(dgl.VERDICT_KEY, required)
        self.assertIn(f"{dgl.VERDICT_KEY}:\n          description:", block)

    def test_the_status_handler_sends_it(self):
        app = (self.ROOT / "src" / "app.ts").read_text(encoding="utf-8")
        handler = app.split("async function handleStatus(", 1)[1].split("\n}\n", 1)[0]
        self.assertRegex(handler, rf"\b{dgl.VERDICT_KEY}: await slotNamesProductionVerdictSource\(")


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

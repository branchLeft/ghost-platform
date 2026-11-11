"""Tests for the Mollie test-mode charge script and the workflow that runs it.

Run: python3 -m unittest discover -s scripts -p 'test_mollie_test_charge.py'
No network: the HTTP layer is a recording fake, and the real one is made to
raise so any call that slips past the fake fails the test.
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
WORKFLOW = REPO / ".github" / "workflows" / "mollie-test-charge.yml"


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


charge = load("mollie_test_charge", "mollie-test-charge.py")

KEY = "test_AbCdEf0123456789AbCdEf0123456789"


def good(prefix: str, status: str = "open", **extra) -> dict:
    return {"id": f"{prefix}12345", "status": status, "mode": "test", **extra}


HAPPY = [
    (201, good("tr_", "open")),
    (201, {"id": "cst_12345", "mode": "test", "status": "n/a"}),
    (201, good("mdt_", "valid")),
    (201, good("sub_", "active")),
]


class FakeTransport:
    """Records every call; answers from a queue of (status, json) pairs."""

    def __init__(self, answers=None, raises=None):
        self.answers = list(HAPPY if answers is None else answers)
        self.raises = raises
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), json.loads(body) if body else None))
        if self.raises:
            raise self.raises
        status, payload = self.answers.pop(0)
        return status, json.dumps(payload).encode()


class Base(unittest.TestCase):
    def setUp(self):
        guard = mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("real network call"))
        guard.start()
        self.addCleanup(guard.stop)

    def run_main(self, env, transport):
        out, err = io.StringIO(), io.StringIO()
        code = charge.main(env=env, transport=transport, out=out, err=err)
        return code, out.getvalue(), err.getvalue()


class KeyRefusal(Base):
    REFUSED = (
        ("unset", {}),
        ("empty", {charge.KEY_ENV: ""}),
        ("blank", {charge.KEY_ENV: "   \n"}),
        ("live key", {charge.KEY_ENV: "live_AbCdEf0123456789AbCdEf0123456789"}),
        ("short live key", {charge.KEY_ENV: "live_x"}),
        ("short test key", {charge.KEY_ENV: "test_x"}),
        ("bare prefix", {charge.KEY_ENV: "test_"}),
        ("upper case prefix", {charge.KEY_ENV: "TEST_AbCdEf0123456789AbCdEf0123456789"}),
        ("test word inside", {charge.KEY_ENV: "live_test_AbCdEf0123456789AbCdEf0123456789"}),
        ("oauth style token", {charge.KEY_ENV: "access_AbCdEf0123456789AbCdEf0123456789"}),
        ("embedded newline", {charge.KEY_ENV: "test_AbCdEf01234\nlive_AbCdEf0123456789"}),
        ("header injection", {charge.KEY_ENV: "test_AbCdEf0123456789\r\nX-Evil: 1"}),
    )

    def test_every_refused_key_exits_two_with_no_network_call(self):
        for label, env in self.REFUSED:
            with self.subTest(label):
                fake = FakeTransport()
                code, out, err = self.run_main(env, fake)
                self.assertEqual(code, charge.EXIT_REFUSED)
                self.assertEqual(fake.calls, [])
                self.assertEqual(out, "")
                self.assertTrue(err.startswith("refused:"))

    def test_a_refused_live_key_is_never_echoed(self):
        live = "live_SecretSecretSecret0123456789ab"
        fake = FakeTransport()
        code, out, err = self.run_main({charge.KEY_ENV: live}, fake)
        self.assertEqual(code, charge.EXIT_REFUSED)
        self.assertNotIn(live, out + err)
        self.assertNotIn("SecretSecret", out + err)

    def test_the_live_key_is_refused_through_the_real_entry_point_too(self):
        # No injected transport: the guarded urlopen would raise if reached.
        code, _, _ = self.run_main({charge.KEY_ENV: "live_x"}, charge.urllib_transport)
        self.assertEqual(code, charge.EXIT_REFUSED)

    def test_surrounding_whitespace_on_a_test_key_is_tolerated(self):
        fake = FakeTransport()
        code, _, _ = self.run_main({charge.KEY_ENV: f"{KEY}\n"}, fake)
        self.assertEqual(code, charge.EXIT_OK)


class HappyPath(Base):
    def setUp(self):
        super().setUp()
        self.fake = FakeTransport()
        self.code, self.out, self.err = self.run_main({charge.KEY_ENV: KEY}, self.fake)

    def test_succeeds_and_says_so(self):
        self.assertEqual(self.code, charge.EXIT_OK)
        self.assertEqual(self.err, "")
        self.assertIn("ok:", self.out)

    def test_makes_the_four_calls_in_order(self):
        urls = [(m, u.removeprefix(charge.API_BASE)) for m, u, _, _ in self.fake.calls]
        self.assertEqual(
            urls,
            [
                ("POST", "/payments"),
                ("POST", "/customers"),
                ("POST", "/customers/cst_12345/mandates"),
                ("POST", "/customers/cst_12345/subscriptions"),
            ],
        )

    def test_every_call_goes_to_mollie_over_https(self):
        for _, url, _, _ in self.fake.calls:
            self.assertTrue(url.startswith("https://api.mollie.com/v2/"))

    def test_sends_the_key_as_a_bearer_token_and_never_asks_for_live(self):
        for _, _, headers, body in self.fake.calls:
            self.assertEqual(headers["Authorization"], f"Bearer {KEY}")
            self.assertNotIn("testmode", body)

    def test_amounts_are_small_fixed_and_placeholder_described(self):
        payment = self.fake.calls[0][3]
        self.assertEqual(payment["amount"], {"currency": "EUR", "value": "1.00"})
        self.assertRegex(payment["description"], r"\A[A-Z_]+\Z")
        schedule = self.fake.calls[3][3]
        self.assertEqual(schedule["amount"], {"currency": "EUR", "value": "1.00"})
        self.assertEqual(schedule["times"], 1)
        self.assertRegex(schedule["description"], r"\A[A-Z_]+\Z")

    def test_no_card_data_in_any_request(self):
        for _, _, _, body in self.fake.calls:
            text = json.dumps(body)
            self.assertNotRegex(text, r"\d{13,19}")
            self.assertNotIn("cardNumber", text)
            self.assertNotIn("cardToken", text)

    def test_output_is_ids_and_statuses_only(self):
        self.assertNotIn(KEY, self.out + self.err)
        self.assertNotIn("Bearer", self.out + self.err)
        self.assertNotIn("Authorization", self.out + self.err)
        self.assertIn("payment id=tr_12345 status=open mode=test", self.out)
        self.assertIn("schedule id=sub_12345 status=active mode=test", self.out)


class Failures(Base):
    def test_a_live_mode_response_fails_and_stops(self):
        answers = [(201, {"id": "tr_1", "status": "open", "mode": "live"})]
        fake = FakeTransport(answers)
        code, _, err = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)
        self.assertEqual(len(fake.calls), 1)
        self.assertIn("mode is not test", err)

    def test_a_missing_mode_fails(self):
        fake = FakeTransport([(201, {"id": "tr_1", "status": "open"})])
        code, _, _ = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)

    def test_a_http_error_fails_with_the_title_and_stops(self):
        answers = [HAPPY[0], (422, {"title": "Unprocessable Entity", "status": 422, "detail": f"echo {KEY}"})]
        fake = FakeTransport(answers)
        code, out, err = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)
        self.assertEqual(len(fake.calls), 2)
        self.assertIn("HTTP 422", err)
        self.assertIn("Unprocessable Entity", err)
        self.assertNotIn(KEY, out + err)
        self.assertNotIn("detail", err)

    def test_a_title_that_echoes_the_key_is_redacted(self):
        fake = FakeTransport([(401, {"title": f"bad {KEY}"})])
        code, out, err = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)
        self.assertNotIn(KEY, out + err)

    def test_a_non_json_body_fails(self):
        def transport(method, url, headers, body):
            return 502, b"<html>bad gateway</html>"

        code, _, err = self.run_main({charge.KEY_ENV: KEY}, transport)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)
        self.assertNotIn("bad gateway", err)

    def test_a_transport_exception_carrying_the_key_is_not_printed(self):
        fake = FakeTransport(raises=OSError(f"connection to host failed with {KEY}"))
        code, out, err = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)
        self.assertNotIn(KEY, out + err)

    def test_a_wrong_id_prefix_fails(self):
        fake = FakeTransport([(201, {"id": "cst_1", "status": "open", "mode": "test"})])
        code, _, _ = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)

    def test_a_failed_mandate_never_reaches_the_schedule(self):
        answers = HAPPY[:2] + [(422, {"title": "Unprocessable Entity"})]
        fake = FakeTransport(answers)
        code, _, _ = self.run_main({charge.KEY_ENV: KEY}, fake)
        self.assertEqual(code, charge.EXIT_STEP_FAILED)
        self.assertEqual(len(fake.calls), 3)


class WorkflowShape(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_dispatch_is_the_only_trigger(self):
        on_block = re.search(r"^on:\n((?:[ \t]+.*\n|\n)+)", self.text, re.MULTILINE).group(1)
        self.assertEqual(re.findall(r"^  ([a-z_]+):", on_block, re.MULTILINE), ["workflow_dispatch"])
        self.assertNotIn("inputs:", self.text)

    def test_waits_on_the_production_environment(self):
        self.assertRegex(self.text, r"(?m)^    environment: production$")

    def test_only_reads_contents(self):
        block = re.search(r"^permissions:\n((?:  .*\n)+)", self.text, re.MULTILINE).group(1)
        self.assertEqual(block.strip(), "contents: read")
        self.assertEqual(self.text.count("permissions:"), 1)

    def test_runs_on_main_only(self):
        self.assertIn("if: github.ref == 'refs/heads/main'", self.text)

    def test_every_action_is_pinned_by_full_sha(self):
        uses = re.findall(r"^\s*(?:- )?uses: (\S+)", self.text, re.MULTILINE)
        self.assertTrue(uses)
        for ref in uses:
            self.assertRegex(ref, r"@[0-9a-f]{40}\Z")

    def test_the_key_is_bound_only_to_the_script_step_and_only_by_env(self):
        self.assertEqual(self.text.count("secrets.MOLLIE_API_KEY_TEST"), 1)
        step = re.search(r"- name: Create the test charge.*?(?=\n      - name:|\Z)", self.text, re.DOTALL).group(0)
        self.assertIn("MOLLIE_API_KEY_TEST: ${{ secrets.MOLLIE_API_KEY_TEST }}", step)
        self.assertIn("run: python3 scripts/mollie-test-charge.py", step)
        self.assertNotIn("${{", step.split("run:")[1])

    def test_the_script_tests_run_before_the_key_is_in_scope(self):
        tests_at = self.text.index("test_mollie_test_charge.py")
        key_at = self.text.index("secrets.MOLLIE_API_KEY_TEST")
        self.assertLess(tests_at, key_at)

    def test_no_live_key_secret_is_named(self):
        self.assertNotRegex(self.text, r"MOLLIE_API_KEY(?!_TEST)")


if __name__ == "__main__":
    unittest.main()

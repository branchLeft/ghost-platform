"""Tests for the real Stripe TEST-mode switch, real_test_mode.py.

Run: python3 -m unittest discover -s csp/gate -p 'test_real_test_mode.py' -v
Every refusal of the switch, and the rule that no key value ever reaches output.
No Docker, no browser, no network, no node. The last class mutates the real source
one rule at a time and requires these same tests to go red.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "real_test_mode.py"
GATE = HERE / "csp-checkout-gate.py"
ORIGIN = "http://localhost:4321"


def load(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


REAL = load(SOURCE, "real_test_mode_under_test")


def make(prefix: str, marker: str) -> str:
    """Shaped like a real key but made up and assembled at run time, so no secret
    scanner (or grep for a live-key prefix) trips on this file. Each carries a marker
    so a leak of any one is found by name."""
    return "_".join([*prefix.split("_"), marker + "Z" * 16])


SECRET = make("sk_test", "SecretMarkerOne")
PUBLISHABLE = make("pk_test", "PubMarkerTwo")
WEBHOOK = make("whsec", "HookMarkerThree")
GOOD = {
    "STRIPE_TEST_SECRET_KEY": SECRET,
    "STRIPE_TEST_PUBLISHABLE_KEY": PUBLISHABLE,
    "STRIPE_TEST_WEBHOOK_SECRET": WEBHOOK,
}
LIVE_SECRET = make("sk_live", "LiveMarkerFour")
RESTRICTED_TEST = make("rk_test", "RestrictedMarkerFive")
RESTRICTED_LIVE = make("rk_live", "RestrictedLiveMarkerSix")
MARKERS = (
    "SecretMarker",
    "PubMarker",
    "HookMarker",
    "LiveMarker",
    "RestrictedMarker",
    "RestrictedLiveMarker",
    "BadShapeMarker",
    "OtherCardMarker",
)
IS_NOT_SET = "is not set or is empty"


if TYPE_CHECKING:
    Checks = unittest.TestCase
else:
    Checks = object


class RealTestModeTests(Checks):
    """The rules. `mode` is the module under test (real or mutated)."""

    mode: ModuleType

    def names(self, env: Mapping[str, str]) -> list[str]:
        return [p.name for p in self.mode.key_problems(env)]

    # --- the keys ---------------------------------------------------------------

    def test_accepts_three_well_formed_test_mode_values_and_a_local_tenant(self) -> None:
        self.assertEqual(self.mode.key_problems(GOOD), [])
        result = self.mode.preflight(GOOD, ORIGIN)
        self.assertTrue(result.ok)
        self.assertIn(
            "stripe listen --forward-to http://localhost:4321/members/webhooks/stripe/",
            "\n".join(result.lines),
        )

    def test_each_missing_or_empty_variable_is_refused_and_named(self) -> None:
        for name in GOOD:
            missing = {k: v for k, v in GOOD.items() if k != name}
            for env in (missing, {**GOOD, name: ""}):
                with self.subTest(name=name, env=len(env)):
                    self.assertEqual(
                        self.mode.key_problems(env), [self.mode.KeyProblem(name, IS_NOT_SET)]
                    )

    def test_a_live_secret_key_is_refused(self) -> None:
        (problem,) = self.mode.key_problems({**GOOD, "STRIPE_TEST_SECRET_KEY": LIVE_SECRET})
        self.assertEqual(problem.name, "STRIPE_TEST_SECRET_KEY")
        self.assertIn("LIVE secret key is refused", problem.problem)

    def test_a_live_publishable_key_is_refused(self) -> None:
        live = make("pk_live", "LiveMarkerFour")
        (problem,) = self.mode.key_problems({**GOOD, "STRIPE_TEST_PUBLISHABLE_KEY": live})
        self.assertEqual(problem.name, "STRIPE_TEST_PUBLISHABLE_KEY")
        self.assertIn("LIVE publishable key is refused", problem.problem)

    def test_a_restricted_key_is_refused_test_or_live(self) -> None:
        for value in (RESTRICTED_TEST, RESTRICTED_LIVE):
            (problem,) = self.mode.key_problems({**GOOD, "STRIPE_TEST_SECRET_KEY": value})
            self.assertEqual(problem.name, "STRIPE_TEST_SECRET_KEY")
            self.assertIn("restricted key is refused", problem.problem)

    def test_a_secret_key_with_the_wrong_shape_is_refused(self) -> None:
        for value in (
            "sk_test_",
            "sk_test_ab-cd",
            "sk_test_ab cd",
            "xsk_test_abcd",
            f"{SECRET}\n",
            f"{SECRET} ",
            "sk_test_abcdé",
            "abcd",
        ):
            with self.subTest(value=value):
                self.assertEqual(
                    self.names({**GOOD, "STRIPE_TEST_SECRET_KEY": value}),
                    ["STRIPE_TEST_SECRET_KEY"],
                )

    def test_a_webhook_secret_with_the_wrong_shape_is_refused(self) -> None:
        for value in ("whsec_", "whsec_ab-cd", "we_abcd", SECRET, f"{WEBHOOK} ", f"{WEBHOOK}\n"):
            with self.subTest(value=value):
                self.assertEqual(
                    self.names({**GOOD, "STRIPE_TEST_WEBHOOK_SECRET": value}),
                    ["STRIPE_TEST_WEBHOOK_SECRET"],
                )

    def test_a_publishable_key_with_the_secret_key_shape_is_refused(self) -> None:
        self.assertEqual(
            self.names({**GOOD, "STRIPE_TEST_PUBLISHABLE_KEY": SECRET}),
            ["STRIPE_TEST_PUBLISHABLE_KEY"],
        )

    # --- the tenant -------------------------------------------------------------

    def test_only_a_local_http_tenant_with_a_port_is_accepted(self) -> None:
        local = self.mode.assert_local_tenant("http://localhost:4321")
        self.assertEqual((local.origin, local.port), ("http://localhost:4321", "4321"))
        loopback = self.mode.assert_local_tenant("http://127.0.0.1:4321")
        self.assertEqual(loopback.origin, "http://127.0.0.1:4321")
        for origin in (
            "https://example.com",
            "http://example.com:4321",
            "http://localhost.example.com:4321",
            "http://localhost@example.com:4321",
            "http://localhost:4321@tenant.example.com",
            "http://evil.example.com\\@localhost:4321",
            "http://user@localhost:4321",
            "http://127.0.0.1.example.com:4321",
            "https://localhost:4321",
            "http://localhost",
            "http://localhost:0",
            "http://localhost:abc",
            "http://192.168.1.10:4321",
            "http://0.0.0.0:4321",
            " http://localhost:4321",
            "http://localhost:4321\n",
            "not a url",
            "",
            None,
        ):
            with self.subTest(origin=origin), self.assertRaises(self.mode.Refusal) as caught:
                self.mode.assert_local_tenant(origin)
            self.assertIn("refusing", str(caught.exception))

    def test_a_refused_tenant_says_what_it_must_be(self) -> None:
        with self.assertRaises(self.mode.Refusal) as caught:
            self.mode.assert_local_tenant("http://localhost:4321@tenant.example.com")
        self.assertIn("local disposable tenant", str(caught.exception))
        with self.assertRaises(self.mode.Refusal) as caught:
            self.mode.assert_local_tenant("not a url")
        self.assertIn("not a URL", str(caught.exception))

    def test_preflight_refuses_a_non_local_tenant_even_with_good_keys(self) -> None:
        result = self.mode.preflight(GOOD, "https://tenant.example.com")
        self.assertFalse(result.ok)
        self.assertIn("local disposable tenant", "\n".join(result.lines))

    # --- the card ---------------------------------------------------------------

    def test_any_card_number_other_than_the_published_test_card_is_refused(self) -> None:
        published = self.mode.PUBLISHED_TEST_CARD
        self.assertEqual(self.mode.assert_published_test_card("4242 4242 4242 4242"), published)
        self.assertEqual(self.mode.assert_published_test_card("4242424242424242"), published)
        self.assertEqual(self.mode.assert_published_test_card("4242-4242-4242-4242"), published)
        for card in ("4000 0000 0000 0002", "5555 5555 5555 4444", "4242 4242 4242 4241", "", None, 4242):
            with self.subTest(card=card), self.assertRaises(self.mode.Refusal) as caught:
                self.mode.assert_published_test_card(card)
            self.assertIn("published test card", str(caught.exception))
        result = self.mode.preflight({**GOOD, "CSP_STRIPE_TEST_CARD": "4000 0000 0000 0002"}, ORIGIN)
        self.assertFalse(result.ok)
        self.assertIn("CSP_STRIPE_TEST_CARD", "\n".join(result.lines))
        self.assertTrue(self.mode.preflight({**GOOD, "CSP_STRIPE_TEST_CARD": "4242424242424242"}, ORIGIN).ok)
        self.assertFalse(self.mode.preflight({**GOOD, "CSP_STRIPE_TEST_CARD": ""}, ORIGIN).ok)

    # --- no value in any output -------------------------------------------------

    def test_no_key_value_and_no_marker_of_one_appears_in_any_refusal_or_accept(self) -> None:
        cases = {
            "all good": dict(GOOD),
            "live key": {**GOOD, "STRIPE_TEST_SECRET_KEY": LIVE_SECRET},
            "restricted test key": {**GOOD, "STRIPE_TEST_SECRET_KEY": RESTRICTED_TEST},
            "restricted live key": {**GOOD, "STRIPE_TEST_SECRET_KEY": RESTRICTED_LIVE},
            "wrong shape secret": {**GOOD, "STRIPE_TEST_SECRET_KEY": "sk_test_BadShapeMarker-bad"},
            "wrong shape webhook": {**GOOD, "STRIPE_TEST_WEBHOOK_SECRET": "we_BadShapeMarkerHook"},
            "unrecognised publishable": {**GOOD, "STRIPE_TEST_PUBLISHABLE_KEY": "BadShapeMarkerPub"},
            "other card": {**GOOD, "CSP_STRIPE_TEST_CARD": "4000 0000 OtherCardMarker"},
        }
        for label, env in cases.items():
            with self.subTest(case=label):
                result = self.mode.preflight(env, ORIGIN)
                seen = "\n".join(result.lines)
                for value in env.values():
                    self.assertNotIn(value, seen, f"{label}: a value appeared in the output")
                for marker in MARKERS:
                    self.assertNotIn(marker, seen, f"{label}: {marker} appeared")
                self.assertEqual(result.ok, label == "all good", label)

    def test_a_refusal_prints_the_full_owner_command_from_names_that_exist(self) -> None:
        result = self.mode.preflight({}, ORIGIN)
        self.assertFalse(result.ok)
        text = "\n".join(result.lines)
        for name in GOOD:
            self.assertIn(f"{name}: {IS_NOT_SET}", text)
        self.assertIn(self.mode.owner_command(), text)
        self.assertIn("stripe listen --print-secret", text)
        self.assertEqual(result.lines[0], "REAL TEST MODE REFUSED:")

    def test_the_owner_command_names_only_variables_the_gate_reads_and_a_script_that_exists(self) -> None:
        self.assertTrue(GATE.is_file())
        block = self.mode.owner_command().split("\n")
        self.assertEqual(len(block), 4)
        for name, line in zip(GOOD, block):
            self.assertEqual(line, f"read -rs {name}; export {name}")
        self.assertEqual(block[3], "CSP_STRIPE_REAL_TEST_MODE=1 csp/gate/csp-checkout-gate.py")
        self.assertNotIn("/Users/", self.mode.usage())
        self.assertIn("localhost:4321", self.mode.usage())
        self.assertIn("localhost:5555", self.mode.usage("5555"))

    # --- redaction --------------------------------------------------------------

    def test_redaction_removes_key_shaped_strings_known_values_and_the_checkout_url_fragment(self) -> None:
        text = f"a {SECRET} b {PUBLISHABLE} c {WEBHOOK} d {LIVE_SECRET} e {RESTRICTED_TEST}"
        out = self.mode.redact_secrets(text)
        for marker in MARKERS:
            self.assertNotIn(marker, out)
        odd = "not-key-shaped-but-known-value-12345"
        self.assertEqual(self.mode.redact_secrets(f"x {odd} y", [odd]), "x [REDACTED] y")
        url = "https://checkout.stripe.com/c/pay/cs_test_abc#fidkdWxOYHwnPyd1blpxYHZxWjA0"
        self.assertEqual(
            self.mode.redact_secrets(f"waiting for {url} done"),
            "waiting for https://checkout.stripe.com/c/pay/cs_test_abc#[REDACTED] done",
        )

    def test_a_value_too_short_to_be_a_secret_is_not_replaced_everywhere(self) -> None:
        self.assertEqual(self.mode.redact_secrets("ab abc ab", ["ab", ""]), "ab abc ab")

    def test_the_longest_known_value_is_redacted_first(self) -> None:
        self.assertEqual(
            self.mode.redact_secrets("x secret-value-long y", ["secret-val", "secret-value-long"]),
            "x [REDACTED] y",
        )

    def test_the_values_to_redact_are_the_set_secret_variables_long_enough_to_be_one(self) -> None:
        env = {
            **GOOD,
            "PROOF_STRIPE_SECRET_KEY": "unshaped-env-secret-value-98765",
            "WEBHOOK_SECRET": "short",
            "UNRELATED": "an-unrelated-long-value",
        }
        self.assertEqual(
            sorted(self.mode.secret_values(env)),
            sorted([SECRET, PUBLISHABLE, WEBHOOK, "unshaped-env-secret-value-98765"]),
        )
        self.assertEqual(self.mode.secret_values({}), [])

    # --- which violations are the tenant's --------------------------------------

    def test_a_violation_is_the_tenants_only_when_its_document_is_the_tenants(self) -> None:
        def violation(uri: object) -> dict[str, object]:
            return {"directive": "script-src-elem", "blockedURI": "x", "documentURI": uri}

        def mine(uri: object) -> bool:
            return bool(self.mode.is_tenant_violation(violation(uri), ORIGIN))

        self.assertTrue(mine("http://localhost:4321/"))
        self.assertTrue(mine("http://localhost:4321/#/portal/account/plans"))
        self.assertFalse(mine("https://checkout.stripe.com/c/pay/cs_test_abc"))
        self.assertFalse(mine("https://js.stripe.com/v3/m-outer.html"))
        self.assertFalse(mine("http://localhost:4322/"), "another port is another origin")
        self.assertFalse(mine("https://localhost:4321/"), "another scheme is another origin")
        self.assertTrue(mine(None), "unplaceable fails closed")
        self.assertTrue(mine("about:srcdoc"), "unplaceable fails closed")
        self.assertTrue(mine("http://"), "unplaceable fails closed")
        self.assertTrue(mine("not a url"), "unplaceable fails closed")
        self.assertTrue(self.mode.is_tenant_violation({"directive": "x"}, ORIGIN))

    def test_a_capture_is_redacted_and_stripes_violations_are_counted_apart(self) -> None:
        tenant = {"directive": "script-src", "documentURI": "http://localhost:4321/"}
        stripe = {"directive": "frame-src", "documentURI": "https://checkout.stripe.com/c/pay/x"}
        run = {
            "error": f"boom {SECRET}",
            "violations": [tenant, stripe, stripe, "odd"],
            "url": "https://checkout.stripe.com/c/pay/cs_test_x#fidkdWxOYHwn",
        }
        out = json.loads(self.mode.scrub_capture(json.dumps(run), ORIGIN, [WEBHOOK]))
        self.assertEqual(out["violations"], [tenant, "odd"])
        self.assertEqual(out["foreignViolations"], 2)
        self.assertEqual(out["error"], "boom [REDACTED]")
        self.assertEqual(out["url"], "https://checkout.stripe.com/c/pay/cs_test_x#[REDACTED]")

    def test_a_capture_with_no_violation_list_or_no_json_is_only_redacted(self) -> None:
        text = f'{{"error": "boom {SECRET}"}}'
        self.assertEqual(self.mode.scrub_capture(text, ORIGIN, []), '{"error": "boom [REDACTED]"}')
        for text in (f"not json {SECRET}", "[1, 2]", '"x"', ""):
            out = self.mode.scrub_capture(text, ORIGIN, [])
            self.assertNotIn("SecretMarker", out)
            self.assertNotIn("foreignViolations", out)


class RealTestMode(RealTestModeTests, unittest.TestCase):
    mode = REAL


# (name, text to replace in the real source, replacement, a test that must go red)
MUTATIONS = [
    (
        "unset key accepted",
        'if value == "":',
        "if False:",
        "test_each_missing_or_empty_variable",
    ),
    (
        "key shape unchecked",
        "elif rule.pattern.fullmatch(value) is None:",
        "elif False:",
        "test_a_secret_key_with_the_wrong_shape",
    ),
    (
        "key shape matched only at the start",
        "elif rule.pattern.fullmatch(value) is None:",
        "elif rule.pattern.match(value) is None:",
        "test_a_secret_key_with_the_wrong_shape",
    ),
    (
        "live secret key accepted",
        're.compile(r"sk_test_[A-Za-z0-9]+")',
        're.compile(r"sk_(?:test|live)_[A-Za-z0-9]+")',
        "test_a_live_secret_key_is_refused",
    ),
    (
        "restricted key accepted",
        're.compile(r"sk_test_[A-Za-z0-9]+")',
        're.compile(r"(?:sk|rk)_test_[A-Za-z0-9]+")',
        "test_a_restricted_key_is_refused",
    ),
    (
        "live publishable key accepted",
        're.compile(r"pk_test_[A-Za-z0-9]+")',
        're.compile(r"pk_(?:test|live)_[A-Za-z0-9]+")',
        "test_a_live_publishable_key_is_refused",
    ),
    (
        "publishable key shape loosened",
        're.compile(r"pk_test_[A-Za-z0-9]+")',
        're.compile(r"(?:sk|pk)_test_[A-Za-z0-9]+")',
        "test_a_publishable_key_with_the_secret_key_shape",
    ),
    (
        "webhook shape loosened",
        're.compile(r"whsec_[A-Za-z0-9]+"),\n        "whsec_ followed',
        're.compile(r"whsec_.*"),\n        "whsec_ followed',
        "test_a_webhook_secret_with_the_wrong_shape",
    ),
    (
        "non-local tenant accepted",
        "host not in LOCAL_HOSTS or ",
        "",
        "test_only_a_local_http_tenant",
    ),
    (
        "https tenant accepted",
        'scheme != "http" or ',
        "",
        "test_only_a_local_http_tenant",
    ),
    (
        "portless tenant accepted",
        "or port is None or port == 0",
        "",
        "test_only_a_local_http_tenant",
    ),
    (
        "userinfo tenant accepted",
        'if "@" in parts.netloc:',
        "if False:",
        "test_only_a_local_http_tenant",
    ),
    (
        "whitespace in a tenant accepted",
        'any(c in origin for c in " \\t\\r\\n") or ',
        "",
        "test_only_a_local_http_tenant",
    ),
    (
        "other card accepted",
        'if digits != PUBLISHED_TEST_CARD.replace(" ", ""):',
        "if False:",
        "test_any_card_number_other_than_the_published_test_card",
    ),
    (
        "preflight skips the tenant check",
        "tenant = assert_local_tenant(origin)",
        'tenant = LocalTenant(origin="http://localhost:4321", port="4321")',
        "test_preflight_refuses_a_non_local_tenant",
    ),
    (
        "preflight skips the card check",
        "assert_published_test_card(env[CARD_ENV])",
        "pass",
        "test_any_card_number_other_than_the_published_test_card",
    ),
    (
        "preflight skips the key check",
        "problems = [f\"{p.name}: {p.problem}\" for p in key_problems(env)]",
        "problems = []",
        "test_a_refusal_prints_the_full_owner_command",
    ),
    (
        "key value echoed in a refusal",
        'f"{kind}; it must be {rule.shape}"',
        'f"{kind}; it must be {rule.shape} (got {value})"',
        "test_no_key_value_and_no_marker_of_one_appears",
    ),
    (
        "redaction of known values removed",
        "out = out.replace(secret, REDACTED)",
        "out = out",
        "test_redaction_removes_key_shaped_strings",
    ),
    (
        "redaction of key shapes removed",
        "out = pattern.sub(REDACTED, out)",
        "out = out",
        "test_redaction_removes_key_shaped_strings",
    ),
    (
        "checkout url fragment kept",
        'return CHECKOUT_FRAGMENT.sub(rf"\\1#{REDACTED}", out)',
        "return out",
        "test_redaction_removes_key_shaped_strings",
    ),
    (
        "short values replaced everywhere",
        "        if len(secret) >= MIN_SECRET_LENGTH:\n            out = out.replace",
        "        if True:\n            out = out.replace",
        "test_a_value_too_short_to_be_a_secret",
    ),
    (
        "shorter value redacted before the longer",
        "sorted(secrets, key=len, reverse=True)",
        "sorted(secrets, key=len)",
        "test_the_longest_known_value_is_redacted_first",
    ),
    (
        "short variables redacted",
        "if len(value) >= MIN_SECRET_LENGTH]",
        "if value]",
        "test_the_values_to_redact_are_the_set_secret_variables",
    ),
    (
        "stripe-side violation counted as the tenant's",
        "return placed is None or placed == tenant",
        "return True",
        "test_a_violation_is_the_tenants_only_when",
    ),
    (
        "unplaceable violation not counted",
        "return placed is None or placed == tenant",
        "return placed == tenant",
        "test_a_violation_is_the_tenants_only_when",
    ),
    (
        "violation with no document not counted",
        "    if not isinstance(document, str):\n        return True",
        "    if not isinstance(document, str):\n        return False",
        "test_a_violation_is_the_tenants_only_when",
    ),
    (
        "violation of another port counted as the tenant's",
        "    return scheme, host, port if port is not None else _DEFAULT_PORTS[scheme]",
        "    return scheme, host, 0",
        "test_a_violation_is_the_tenants_only_when",
    ),
    (
        "foreign violations not counted",
        'run["foreignViolations"] = len(violations) - len(ours)',
        'run["foreignViolations"] = 0',
        "test_a_capture_is_redacted_and_stripes_violations",
    ),
    (
        "foreign violations kept in the capture",
        'run["violations"] = ours',
        'run["violations"] = violations',
        "test_a_capture_is_redacted_and_stripes_violations",
    ),
    (
        "capture not redacted",
        "redacted = redact_secrets(text, secrets)",
        "redacted = text",
        "test_a_capture_is_redacted_and_stripes_violations",
    ),
    (
        "owner command names a variable the gate does not read",
        '"read -rs STRIPE_TEST_WEBHOOK_SECRET; export STRIPE_TEST_WEBHOOK_SECRET"',
        '"read -rs STRIPE_WEBHOOK_SECRET; export STRIPE_WEBHOOK_SECRET"',
        "test_the_owner_command_names_only_variables",
    ),
]


class SabotageProof(unittest.TestCase):
    """Break the real source one rule at a time: the tests above must go red."""

    def mutated(self, old: str, new: str) -> ModuleType:
        source = SOURCE.read_text()
        self.assertEqual(
            source.count(old),
            1,
            f"sabotage target must appear exactly once, or the mutation proves nothing: {old!r}",
        )
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "mutated_real_test_mode.py"
        path.write_text(source.replace(old, new, 1))
        return load(path, f"real_test_mode_mutated_{abs(hash(old + new))}")

    def failing_tests(self, module: ModuleType) -> list[str]:
        suite_class = type("MutatedRules", (RealTestModeTests, unittest.TestCase), {"mode": module})
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(suite_class)
        result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
        return [str(case) for case, _ in result.failures + result.errors]

    def test_each_mutation_turns_the_named_test_red(self) -> None:
        for name, old, new, expected in MUTATIONS:
            with self.subTest(mutation=name):
                failed = self.failing_tests(self.mutated(old, new))
                self.assertTrue(
                    any(expected in test for test in failed),
                    f"{name}: expected {expected} to fail, failing: {failed}",
                )

    def test_the_unmutated_source_is_green(self) -> None:
        self.assertEqual(self.failing_tests(REAL), [])


if __name__ == "__main__":
    unittest.main()

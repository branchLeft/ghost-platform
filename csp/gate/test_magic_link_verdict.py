"""Tests for the magic-link verdict, magic_link_verdict.py.

Run: python3 -m unittest discover -s csp/gate -p 'test_magic_link_verdict.py' -v
No Docker, no browser: the verdict reads one JSON capture. The last class mutates
the real source one rule at a time and requires these same tests to go red.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "magic_link_verdict.py"
ORIGIN = "http://localhost:4331"


def load(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


REAL = load(SOURCE, "magic_link_verdict_real")
STEPS = list(REAL.STEPS)


def good() -> dict[str, object]:
    """A capture of a round trip that held."""
    return {
        "label": "magic-link",
        "steps": list(STEPS),
        "violations": [],
        "foreignRequests": [],
        "thirdPartyImages": [],
        "portalScriptUrl": f"{ORIGIN}/bl-assets/portal.min.js",
        "mailTo": "member@example.test",
        "linkOrigin": ORIGIN,
        "finalUrl": f"{ORIGIN}/?action=signup&success=true",
        "memberSession": True,
        "failedAt": None,
        "error": None,
    }


class VerdictTests:
    """The verdict's behaviour. `verdict` is the module under test (real or mutated)."""

    verdict: ModuleType

    def failures(self, **changes: object) -> list[str]:
        return list(self.verdict.judge({**good(), **changes}, ORIGIN))

    def assert_one_failure(self, expected: str, **changes: object) -> None:
        failures = self.failures(**changes)
        self.assertEqual(len(failures), 1, failures)
        self.assertIn(expected, failures[0])

    def test_a_complete_round_trip_with_no_violations_holds(self) -> None:
        self.assertEqual(self.failures(), [])

    def test_a_violation_in_any_frame_is_red_and_named(self) -> None:
        violation = {
            "directive": "script-src-elem",
            "blockedURI": "https://cdn.example.test/x.js",
            "frame": "about:srcdoc",
        }
        self.assert_one_failure(
            "1 content-policy violation(s): script-src-elem blocked https://cdn.example.test/x.js (in about:srcdoc)",
            violations=[violation],
        )

    def test_many_violations_are_counted_and_only_the_first_few_listed(self) -> None:
        many = [{"directive": "d", "blockedURI": f"u{i}", "frame": "f"} for i in range(8)]
        (failure,) = self.failures(violations=many)
        self.assertIn("8 content-policy violation(s)", failure)
        self.assertIn("and 3 more", failure)
        self.assertNotIn("u7", failure)

    def test_a_run_that_stopped_is_red_with_where_and_why(self) -> None:
        failures = self.failures(failedAt="after signup-sent", error="timed out waiting for the link")
        self.assertIn("the browser run stopped after signup-sent: timed out waiting for the link", failures[0])

    def test_every_step_must_happen_in_order(self) -> None:
        for steps in (STEPS[:-1], list(reversed(STEPS)), [*STEPS, "extra"], []):
            with self.subTest(steps=steps):
                self.assertTrue(any("the steps were" in f for f in self.failures(steps=steps)))

    def test_the_mailed_link_must_point_at_the_tenants_own_origin(self) -> None:
        for origin in ("https://elsewhere.example.test", None):
            with self.subTest(origin=origin):
                self.assert_one_failure("does not point at the tenant's own origin", linkOrigin=origin)

    def test_a_member_session_is_required(self) -> None:
        self.assert_one_failure("did not serve a member session", memberSession=False)

    def test_ghost_must_send_the_browser_back_as_a_signup_success(self) -> None:
        for final in (
            f"{ORIGIN}/?action=signin&success=true",
            f"{ORIGIN}/?action=signup&success=false",
            f"{ORIGIN}/",
            None,
        ):
            with self.subTest(final=final):
                self.assert_one_failure("action=signup&success=true", finalUrl=final)

    def test_portal_must_have_loaded_from_the_tenants_own_origin(self) -> None:
        for url in (None, "https://cdn.jsdelivr.net/ghost/portal@~2.72/umd/portal.min.js"):
            with self.subTest(url=url):
                self.assert_one_failure("Portal did not load from the tenant's own origin", portalScriptUrl=url)

    def test_a_non_image_request_off_the_origin_is_red(self) -> None:
        self.assert_one_failure(
            "1 request(s) off the tenant's origin: script https://cdn.example.test",
            foreignRequests=["script https://cdn.example.test"],
        )

    def test_a_third_party_image_is_a_note_and_not_a_failure(self) -> None:
        run = {**good(), "thirdPartyImages": ["https://www.gravatar.com/avatar/abc"]}
        self.assertEqual(self.verdict.judge(run, ORIGIN), [])
        (note,) = self.verdict.notes(run)
        self.assertIn("1 third-party image(s) loaded", note)
        self.assertIn("https://www.gravatar.com/avatar/abc", note)
        self.assertEqual(self.verdict.notes(good()), [])

    def test_several_failures_are_all_reported(self) -> None:
        failures = self.failures(memberSession=False, linkOrigin="http://x.test")
        self.assertEqual(len(failures), 2)

    # --- the command line ----------------------------------------------------

    def cli(self, stdin: str, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        saved = sys.stdin
        sys.stdin = io.StringIO(stdin)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = int(self.verdict.main(list(argv)))
        finally:
            sys.stdin = saved
        return code, out.getvalue(), err.getvalue()

    def test_the_command_exits_zero_on_a_holding_capture(self) -> None:
        code, out, _ = self.cli(json.dumps(good()), ORIGIN)
        self.assertEqual(code, 0)
        self.assertIn("MAGIC LINK GATE GREEN", out)

    def test_the_command_exits_one_on_a_violation_and_names_it(self) -> None:
        run = {**good(), "violations": [{"directive": "style-src-elem", "blockedURI": "inline", "frame": "f"}]}
        code, out, _ = self.cli(json.dumps(run), ORIGIN)
        self.assertEqual(code, 1)
        self.assertIn("MAGIC LINK GATE RED: 1 check(s) failed", out)
        self.assertIn("style-src-elem blocked inline", out)

    def test_the_command_prints_the_third_party_note_but_stays_green(self) -> None:
        run = {**good(), "thirdPartyImages": ["https://www.gravatar.com/avatar/abc"]}
        code, out, _ = self.cli(json.dumps(run), ORIGIN)
        self.assertEqual(code, 0)
        self.assertIn("NOTE: 1 third-party image(s)", out)

    def test_the_command_refuses_what_is_not_a_capture(self) -> None:
        self.assertEqual(self.cli("not json", ORIGIN)[0], 2)
        self.assertEqual(self.cli("[1]", ORIGIN)[0], 2)
        self.assertEqual(self.cli(json.dumps(good()))[0], 2)


class Behaviour(VerdictTests, unittest.TestCase):
    verdict = REAL


# (name, text to replace in the real source, replacement, a test that must go red)
MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        "violations ignored",
        "    if violations:\n",
        "    if False:\n",
        "test_a_violation_in_any_frame_is_red_and_named",
    ),
    (
        "an error in the run ignored",
        '    if run.get("error"):\n',
        "    if False:\n",
        "test_a_run_that_stopped_is_red_with_where_and_why",
    ),
    (
        "step order not checked",
        "    if steps != list(STEPS):\n",
        "    if False:\n",
        "test_every_step_must_happen_in_order",
    ),
    (
        "link origin not checked",
        '    if run.get("linkOrigin") != origin:\n',
        "    if False:\n",
        "test_the_mailed_link_must_point_at_the_tenants_own_origin",
    ),
    (
        "member session not required",
        '    if run.get("memberSession") is not True:\n',
        "    if False:\n",
        "test_a_member_session_is_required",
    ),
    (
        "return address not checked",
        '    if query.get("action") != ["signup"] or query.get("success") != ["true"]:\n',
        "    if False:\n",
        "test_ghost_must_send_the_browser_back_as_a_signup_success",
    ),
    (
        "Portal's origin not checked",
        '    if run.get("portalScriptUrl") != f"{origin}{PORTAL_PATH}":\n',
        "    if False:\n",
        "test_portal_must_have_loaded_from_the_tenants_own_origin",
    ),
    (
        "requests off the origin allowed",
        "    if foreign:\n",
        "    if False:\n",
        "test_a_non_image_request_off_the_origin_is_red",
    ),
    (
        "a third-party image made a failure",
        '    images = [str(item) for item in as_list(run.get("thirdPartyImages"))]\n    if not images:\n        return []\n',
        '    images = [str(item) for item in as_list(run.get("thirdPartyImages"))]\n    if not images:\n        return []\n    raise SystemExit(1)\n',
        "test_the_command_prints_the_third_party_note_but_stays_green",
    ),
    (
        "violation list not truncated",
        "    shown = \"; \".join(items[:MAX_LISTED])\n",
        "    shown = \"; \".join(items)\n",
        "test_many_violations_are_counted_and_only_the_first_few_listed",
    ),
    (
        "exit code ignores the failures",
        "    if failures:\n        for failure in failures:",
        "    if False:\n        for failure in failures:",
        "test_the_command_exits_one_on_a_violation_and_names_it",
    ),
]


class SabotageProof(unittest.TestCase):
    """Break the real source one rule at a time: the tests above must go red."""

    def mutated(self, old: str, new: str) -> ModuleType:
        source = SOURCE.read_text()
        self.assertIn(old, source, "sabotage target not found: a mutation that changed nothing proves nothing")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "mutated_verdict.py"
        path.write_text(source.replace(old, new, 1))
        return load(path, f"magic_link_verdict_mutated_{abs(hash(old))}")

    def failing_tests(self, module: ModuleType) -> list[str]:
        suite_class = type("MutatedBehaviour", (VerdictTests, unittest.TestCase), {"verdict": module})
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

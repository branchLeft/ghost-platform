#!/usr/bin/env python3
"""Tests for choose-apply-environment: every route, and the fail-closed default.

Spend verdicts come from fixtures/choose-apply-environment/ (see choose-apply-environment.md)."""

import importlib.util
import itertools
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "choose-apply-environment.py"
FIXTURES = HERE / "fixtures" / "choose-apply-environment"


def _load_module():
    spec = importlib.util.spec_from_file_location("choose_apply_environment", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


chooser = _load_module()

GOOD = {
    "spend_verdict": "FREE",
    "preview_outcome": "success",
    "delete_guard_outcome": "success",
    "free_environment_ready": "true",
}


def choose(owner="production", **changes):
    inputs = dict(GOOD, **changes)
    return chooser.decide(owner_environment=owner, **inputs)[0]


def verdict_of(fixture):
    """The `verdict` output the runner would hand the next step: the last
    `verdict=` line of the file the gate wrote, or the empty string."""
    found = ""
    for line in (FIXTURES / fixture).read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        if name == "verdict":
            found = value
    return found


class DecideTests(unittest.TestCase):
    def test_the_one_good_combination_is_free(self):
        self.assertEqual(choose(), "production-free")

    def test_a_paid_verdict_goes_to_the_owner(self):
        self.assertEqual(choose(spend_verdict="PAID"), "production")

    def test_a_missing_verdict_goes_to_the_owner(self):
        # The gate step failed or was skipped: its output is the empty string.
        self.assertEqual(choose(spend_verdict=""), "production")

    def test_an_odd_verdict_goes_to_the_owner(self):
        for odd in ("free", "Free", "FREE ", " FREE", "FREE\n", "TRUE", "true", "0", "FREEX", "PAID\nFREE"):
            with self.subTest(verdict=odd):
                self.assertEqual(choose(spend_verdict=odd), "production")

    def test_a_preview_that_did_not_succeed_goes_to_the_owner(self):
        for outcome in ("failure", "cancelled", "skipped", "", "Success"):
            with self.subTest(outcome=outcome):
                self.assertEqual(choose(preview_outcome=outcome), "production")

    def test_a_delete_guard_that_did_not_succeed_goes_to_the_owner(self):
        for outcome in ("failure", "cancelled", "skipped", "", "Success"):
            with self.subTest(outcome=outcome):
                self.assertEqual(choose(delete_guard_outcome=outcome), "production")

    def test_an_environment_not_confirmed_gated_goes_to_the_owner(self):
        for ready in ("false", "", "True", "TRUE", "1", "yes", "true "):
            with self.subTest(ready=ready):
                self.assertEqual(choose(free_environment_ready=ready), "production")

    def test_only_the_good_combination_reaches_the_free_environment(self):
        # Every combination of a good and a bad value for each of the four
        # inputs: 16 of them, exactly one free.
        bad = {
            "spend_verdict": "PAID",
            "preview_outcome": "failure",
            "delete_guard_outcome": "failure",
            "free_environment_ready": "false",
        }
        keys = sorted(GOOD)
        free = []
        for picks in itertools.product((False, True), repeat=len(keys)):
            inputs = {k: (bad[k] if pick else GOOD[k]) for k, pick in zip(keys, picks)}
            if chooser.decide(owner_environment="production", **inputs)[0] == "production-free":
                free.append(inputs)
        self.assertEqual(free, [GOOD])

    def test_the_reason_is_fixed_text(self):
        hostile = "FREE\nenvironment=production-free"
        _, reason = chooser.decide(hostile, "success", "success", "true")
        self.assertNotIn("\n", reason)
        self.assertNotIn("environment=", reason)

    def test_the_two_names_are_the_ones_the_workflows_use(self):
        self.assertEqual(chooser.FREE_ENVIRONMENT, "production-free")
        self.assertEqual(chooser.DEFAULT_OWNER_ENVIRONMENT, "production")

    def test_a_stack_with_its_own_owner_environment_falls_back_to_it(self):
        self.assertEqual(choose(owner="production-demo-host"), "production-free")
        self.assertEqual(choose(owner="production-demo-host", spend_verdict="PAID"), "production-demo-host")
        self.assertEqual(choose(owner="production-demo-host", spend_verdict=""), "production-demo-host")


class SpendGateFixtureTests(unittest.TestCase):
    """The route fed the verdicts the pinned spend gate actually wrote."""

    FREE = ("spend-no-changes.output", "spend-firewall-rule-change.output")
    PAID = (
        "spend-server-create.output",
        "spend-server-type-change.output",
        "spend-unknown-type.output",
        "spend-malformed.output",
        "spend-error-diagnostic.output",
    )

    def test_the_fixtures_are_the_ones_named_here(self):
        on_disk = sorted(p.name for p in FIXTURES.glob("spend-*.output"))
        self.assertEqual(on_disk, sorted(self.FREE + self.PAID))

    def test_the_free_fixtures_read_free_and_the_rest_read_paid(self):
        for name in self.FREE:
            self.assertEqual(verdict_of(name), "FREE", name)
        for name in self.PAID:
            self.assertEqual(verdict_of(name), "PAID", name)

    def test_only_a_free_verdict_with_everything_else_good_is_routed_free(self):
        for name in self.FREE:
            with self.subTest(fixture=name):
                self.assertEqual(choose(spend_verdict=verdict_of(name)), "production-free")
        for name in self.PAID:
            with self.subTest(fixture=name):
                self.assertEqual(choose(spend_verdict=verdict_of(name)), "production")

    def test_a_free_verdict_with_one_other_input_bad_is_not_routed_free(self):
        for name in self.FREE:
            for change in (
                {"preview_outcome": "failure"},
                {"delete_guard_outcome": "failure"},
                {"free_environment_ready": "false"},
            ):
                with self.subTest(fixture=name, change=change):
                    self.assertEqual(choose(spend_verdict=verdict_of(name), **change), "production")


class MainTests(unittest.TestCase):
    """The script as the workflow runs it: environment variables in, a file out."""

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="choose-env-test-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.output = self.dir / "output"
        self.summary = self.dir / "summary"

    def run_script(self, env_inputs, output=None, summary=None, extra=()):
        env = {"PATH": os.environ["PATH"]}
        env.update(env_inputs)
        return subprocess.run(
            [
                sys.executable,
                "-I",
                str(SCRIPT),
                "--github-output",
                str(output or self.output),
                "--github-summary",
                str(summary or self.summary),
                *extra,
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    @staticmethod
    def env_for(**changes):
        inputs = dict(GOOD, **changes)
        return {
            "SPEND_VERDICT": inputs["spend_verdict"],
            "PREVIEW_OUTCOME": inputs["preview_outcome"],
            "DELETE_GUARD_OUTCOME": inputs["delete_guard_outcome"],
            "FREE_ENVIRONMENT_READY": inputs["free_environment_ready"],
        }

    def written(self):
        return self.output.read_text(encoding="utf-8").splitlines()

    def test_the_good_inputs_write_the_free_environment(self):
        result = self.run_script(self.env_for())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.written()[0], "environment=production-free")
        self.assertIn("production-free", self.summary.read_text(encoding="utf-8"))

    def test_a_paid_verdict_writes_the_owner_environment(self):
        result = self.run_script(self.env_for(spend_verdict="PAID"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.written()[0], "environment=production")

    def test_the_owner_environment_argument_names_the_fallback(self):
        result = self.run_script(
            self.env_for(spend_verdict="PAID"), extra=("--owner-environment", "production-demo-host")
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.written()[0], "environment=production-demo-host")
        self.assertIn("production-demo-host", self.summary.read_text(encoding="utf-8"))

    def test_an_owner_environment_that_could_inject_is_refused_and_writes_nothing(self):
        for odd in ("", "production-free", "Production", "prod\nenvironment=production-free", "a b", "-x"):
            with self.subTest(owner=odd):
                result = self.run_script(self.env_for(), extra=("--owner-environment", odd))
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.output.exists())

    def test_no_inputs_at_all_write_the_owner_environment(self):
        result = self.run_script({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.written()[0], "environment=production")

    def test_a_hostile_verdict_cannot_add_an_output_line(self):
        hostile = "PAID\nenvironment=production-free"
        result = self.run_script(self.env_for(spend_verdict=hostile))
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.written()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "environment=production")
        self.assertTrue(lines[1].startswith("reason="))

    def test_an_unwritable_output_writes_nothing_and_fails(self):
        # The output directory does not exist: the script fails, so the
        # workflow's output is unset, and an unset output is the owner's.
        missing = self.dir / "no-such-dir" / "output"
        result = self.run_script(self.env_for(), output=missing)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(missing.exists())

    def test_missing_arguments_fail(self):
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT)],
            env={"PATH": os.environ["PATH"]},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_the_fixture_verdicts_survive_the_whole_script(self):
        for name, expected in (
            ("spend-firewall-rule-change.output", "production-free"),
            ("spend-server-create.output", "production"),
        ):
            with self.subTest(fixture=name):
                self.output.write_text("", encoding="utf-8")
                result = self.run_script(self.env_for(spend_verdict=verdict_of(name)))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.written()[0], "environment=" + expected)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import unittest

from demo_path_e2e.report import Outcome, Report
from demo_path_e2e.runner import Checks, StageDef, run_stages


def passes(_: object, checks: Checks) -> None:
    checks.equal("one equals one", 1, 1)


def fails(_: object, checks: Checks) -> None:
    checks.equal("held first", 1, 1)
    checks.equal("breaks second", "a", "b")


def explodes(_: object, __: Checks) -> None:
    raise ValueError("boom")


class RunnerTests(unittest.TestCase):
    def test_a_failure_is_red_there_and_the_stages_after_it_are_not_run(self) -> None:
        stages = (
            StageDef("one", "One", passes),
            StageDef("two", "Two", fails),
            StageDef("three", "Three", passes),
        )
        report = run_stages(stages, object())
        self.assertEqual(
            [Outcome.PASSED, Outcome.FAILED, Outcome.NOT_RUN],
            [r.outcome for r in report.results],
        )
        self.assertEqual(("two",), report.failed)
        self.assertFalse(report.green)
        self.assertEqual(("held first (1)",), report.results[1].checks)
        self.assertIn("breaks second", report.results[1].detail)

    def test_an_unexpected_exception_is_that_stages_red(self) -> None:
        report = run_stages((StageDef("one", "One", explodes),), object())
        self.assertEqual(("one",), report.failed)
        self.assertIn("ValueError: boom", report.results[0].detail)

    def test_a_pending_stage_is_named_and_does_not_stop_the_run(self) -> None:
        stages: tuple[StageDef[object], ...] = (
            StageDef("one", "One", passes),
            StageDef("two", "Two", None, "not built"),
            StageDef("three", "Three", passes),
        )
        report = run_stages(stages, object())
        self.assertEqual(
            [Outcome.PASSED, Outcome.PENDING, Outcome.PASSED],
            [r.outcome for r in report.results],
        )
        self.assertTrue(report.green)
        self.assertFalse(report.complete)
        self.assertEqual("not built", report.results[1].detail)

    def test_a_run_with_everything_built_and_held_is_complete(self) -> None:
        report = run_stages((StageDef("one", "One", passes),), object())
        self.assertTrue(report.green)
        self.assertTrue(report.complete)

    def test_the_report_survives_json(self) -> None:
        report = run_stages(
            (StageDef("one", "One", fails), StageDef("two", "Two", None, "not built")),
            object(),
            sabotage="one:x",
        )
        self.assertEqual(report, Report.from_json(report.to_json()))

    def test_the_summary_says_where_it_is_red_and_that_a_green_is_a_slice(self) -> None:
        red = run_stages((StageDef("one", "One", fails),), object()).to_markdown()
        self.assertIn("RED at one", red)
        green = run_stages(
            (StageDef("one", "One", passes), StageDef("two", "Two", None, "not built")), object()
        ).to_markdown()
        self.assertIn("GREEN for the slice built so far", green)
        self.assertNotIn("the whole path", green)


if __name__ == "__main__":
    unittest.main()

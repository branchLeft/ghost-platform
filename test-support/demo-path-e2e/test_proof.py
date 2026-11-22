from __future__ import annotations

import unittest

from demo_path_e2e import sabotage as sabotages
from demo_path_e2e.proof import problems_with
from demo_path_e2e.report import Outcome, Report, StageResult

BUILT = ("a", "b", "c")
TARGET = sabotages.Sabotage("b", sabotages.Fault.WRONG_HASH, "x")


def report(*outcomes: Outcome, sabotage: str = TARGET.name) -> Report:
    ids = ("a", "b", "c")
    results = [StageResult(i, i, o) for i, o in zip(ids, outcomes, strict=True)]
    # A pending stage in the middle of the path changes nothing.
    results.insert(1, StageResult("p", "p", Outcome.PENDING))
    return Report(tuple(results), sabotage)


class ProofTests(unittest.TestCase):
    def test_red_at_the_sabotaged_stage_and_nowhere_else_holds(self) -> None:
        self.assertEqual([], problems_with(report(Outcome.PASSED, Outcome.FAILED, Outcome.NOT_RUN), TARGET, BUILT))

    def test_a_run_that_stayed_green_is_a_broken_control(self) -> None:
        found = problems_with(report(Outcome.PASSED, Outcome.PASSED, Outcome.PASSED), TARGET, BUILT)
        self.assertTrue(any("b: expected failed" in p for p in found))

    def test_red_at_an_earlier_stage_is_a_broken_control(self) -> None:
        found = problems_with(report(Outcome.FAILED, Outcome.NOT_RUN, Outcome.NOT_RUN), TARGET, BUILT)
        self.assertTrue(any("a went red too" in p for p in found))

    def test_a_later_stage_that_ran_is_a_broken_control(self) -> None:
        found = problems_with(report(Outcome.PASSED, Outcome.FAILED, Outcome.PASSED), TARGET, BUILT)
        self.assertTrue(any("c: expected not_run" in p for p in found))

    def test_a_run_made_under_another_sabotage_is_refused(self) -> None:
        found = problems_with(
            report(Outcome.PASSED, Outcome.FAILED, Outcome.NOT_RUN, sabotage="other"), TARGET, BUILT
        )
        self.assertTrue(any("not " in p and "other" in p for p in found))

    def test_a_sabotage_of_a_stage_that_is_not_built_is_refused(self) -> None:
        orphan = sabotages.Sabotage("zzz", sabotages.Fault.WRONG_HASH, "x")
        found = problems_with(report(Outcome.PASSED, Outcome.PASSED, Outcome.PASSED, sabotage=orphan.name), orphan, BUILT)
        self.assertTrue(any("not a built stage" in p for p in found))


if __name__ == "__main__":
    unittest.main()

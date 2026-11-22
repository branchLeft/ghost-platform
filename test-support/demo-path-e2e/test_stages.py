"""Each built stage against an in-memory edge: green on a sound one, red on each fault the sabotage makes."""

from __future__ import annotations

import unittest

from demo_path_e2e.report import Outcome
from demo_path_e2e.runner import run_stages
from demo_path_e2e.stages import STAGES
from test_support import FakeEdge


def outcomes(edge: FakeEdge) -> dict[str, Outcome]:
    return {r.stage_id: r.outcome for r in run_stages(STAGES, edge).results}


class StagesAgainstAFakeEdge(unittest.TestCase):
    def test_a_sound_edge_passes_every_built_stage(self) -> None:
        got = outcomes(FakeEdge())
        self.assertEqual(Outcome.PASSED, got["gated-read"])
        self.assertEqual(Outcome.PASSED, got["recycle"])

    def test_a_hash_that_is_not_the_issued_passphrases_is_red_at_gated_read_only(self) -> None:
        got = outcomes(FakeEdge(wrong_hash=True))
        self.assertEqual(Outcome.FAILED, got["gated-read"])
        self.assertEqual(Outcome.NOT_RUN, got["recycle"])

    def test_an_ungated_admin_area_is_red_at_gated_read_only(self) -> None:
        got = outcomes(FakeEdge(exempt_ghost=True))
        self.assertEqual(Outcome.FAILED, got["gated-read"])
        self.assertEqual(Outcome.NOT_RUN, got["recycle"])

    def test_a_recycle_that_keeps_the_hash_is_red_at_recycle_only(self) -> None:
        got = outcomes(FakeEdge(keep_hash_on_recycle=True))
        self.assertEqual(Outcome.PASSED, got["gated-read"])
        self.assertEqual(Outcome.FAILED, got["recycle"])

    def test_the_failure_names_what_was_seen(self) -> None:
        report = run_stages(STAGES, FakeEdge(keep_hash_on_recycle=True))
        failed = next(r for r in report.results if r.outcome is Outcome.FAILED)
        self.assertIn("outgoing passphrase after the recycle", failed.detail)
        self.assertIn("saw 303", failed.detail)

    def test_a_sound_run_is_green_and_not_complete_while_stages_are_pending(self) -> None:
        report = run_stages(STAGES, FakeEdge())
        self.assertTrue(report.green)
        self.assertFalse(report.complete)


if __name__ == "__main__":
    unittest.main()

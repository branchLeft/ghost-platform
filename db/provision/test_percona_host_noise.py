#!/usr/bin/env python3
"""A host too slow to judge control 2 is inconclusive, never an inadequate
candidate. No Docker: the verdict and exit-code logic runs on the baselines
recorded from real runs (percona_snapshot_probe_noisy_host.json)."""

from __future__ import annotations

import json
import pathlib
import unittest

import percona_snapshot_probe as psp
import snapshot_probe as sp

_FIXTURE = json.loads((pathlib.Path(__file__).resolve().parent / "percona_snapshot_probe_noisy_host.json").read_text(encoding="utf-8"))

ALL_GREEN = {1: True, 2: True, 3: True, 4: True, 5: True, 6: True}
ONLY_CONTROL_2_FAILS = {**ALL_GREEN, 2: False}
NOISY_RUNS = ("noisy", "noisy_second")


def _samples(worst: dict[str, float]) -> dict[str, list[float]]:
    return {tenant: [0.004, value] for tenant, value in worst.items()}


class HostNoiseBoundTests(unittest.TestCase):
    def test_the_bound_sits_between_the_passing_runs_and_the_limit(self) -> None:
        passing_worst_baseline = max(_FIXTURE["quiet"]["baseline"].values())
        self.assertGreater(psp.HOST_BASELINE_BOUND_SECONDS, passing_worst_baseline)
        self.assertLess(psp.HOST_BASELINE_BOUND_SECONDS, min(_FIXTURE["noisy"]["baseline"].values()))
        self.assertLess(psp.HOST_BASELINE_BOUND_SECONDS, psp.LATENCY_LIMIT_SECONDS)

    def test_the_candidate_threshold_is_unchanged(self) -> None:
        self.assertEqual(psp.LATENCY_LIMIT_SECONDS, 0.100)
        self.assertEqual(sp.WRITER_LIMIT_SECONDS, 0.100)

    def test_the_inconclusive_exit_is_distinct(self) -> None:
        codes = {psp.EXIT_PASSED, psp.EXIT_RED, psp.EXIT_SABOTAGE_NOT_DETECTED, psp.EXIT_CANDIDATE_INADEQUATE, psp.EXIT_FINDING_NOT_RECORDED, psp.EXIT_REFUSED, 64}
        self.assertNotIn(psp.EXIT_HOST_TOO_NOISY, codes)

    def test_noisy_hosts_names_only_tenants_over_the_bound(self) -> None:
        self.assertEqual(psp.noisy_tenants({"t1": 0.0235, "t2": 0.0251}, psp.HOST_BASELINE_BOUND_SECONDS), [])
        self.assertEqual(psp.noisy_tenants(_FIXTURE["noisy"]["baseline"], psp.HOST_BASELINE_BOUND_SECONDS), ["t1", "t2", "t3"])
        self.assertEqual(psp.noisy_tenants({"t1": 0.2, "t2": 0.02}, psp.HOST_BASELINE_BOUND_SECONDS), ["t1"])


class NoisyBaselineRecordedFixtureTests(unittest.TestCase):
    """The pull-request run that was judged inadequate by a slow host."""

    def test_the_recorded_noisy_run_is_inconclusive_not_inadequate(self) -> None:
        for name in NOISY_RUNS:
            run = _FIXTURE[name]
            verdict = psp.latency_verdict(_samples(run["worst"]), psp.LATENCY_LIMIT_SECONDS, run["baseline"])
            self.assertFalse(verdict.passed, name)
            code = psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=run["baseline"], worst=run["worst"])
            self.assertEqual(code, psp.EXIT_HOST_TOO_NOISY, name)
            self.assertNotEqual(code, psp.EXIT_CANDIDATE_INADEQUATE, name)

    def test_the_message_says_inconclusive_and_never_inadequate(self) -> None:
        message = psp.outcome_message(psp.EXIT_HOST_TOO_NOISY, "", _FIXTURE["noisy"]["baseline"])
        self.assertIn("host too noisy: inconclusive", message)
        self.assertNotIn("INADEQUATE", message.upper())
        self.assertIn("205.7 ms", message)

    def test_the_same_failure_on_a_quiet_host_is_still_inadequate(self) -> None:
        baseline, worst = _FIXTURE["quiet"]["baseline"], _FIXTURE["noisy"]["worst"]
        verdict = psp.latency_verdict(_samples(worst), psp.LATENCY_LIMIT_SECONDS, baseline)
        self.assertFalse(verdict.passed)
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=baseline, worst=worst), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_quiet_run_passes_exactly_as_before(self) -> None:
        baseline = _FIXTURE["quiet"]["baseline"]
        self.assertTrue(psp.latency_verdict(_samples(_FIXTURE["quiet"]["worst"]), psp.LATENCY_LIMIT_SECONDS, baseline).passed)
        self.assertEqual(psp.exit_code(ALL_GREEN, sabotaged=False, baseline=baseline), psp.EXIT_PASSED)

    def test_a_noisy_host_that_still_passes_control_2_passes(self) -> None:
        self.assertEqual(psp.exit_code(ALL_GREEN, sabotaged=False, baseline=_FIXTURE["noisy"]["baseline"], worst=_FIXTURE["noisy"]["worst"]), psp.EXIT_PASSED)


class HostNoiseSabotageTests(unittest.TestCase):
    """Each case would let a real candidate failure hide behind the new exit."""

    NOISY = _FIXTURE["noisy"]["baseline"]
    WORST = _FIXTURE["noisy"]["worst"]

    def test_another_failed_control_is_still_inadequate_on_a_noisy_host(self) -> None:
        for control in (1, 3, 4, 5):
            outcomes = {**ONLY_CONTROL_2_FAILS, control: False}
            self.assertEqual(psp.exit_code(outcomes, sabotaged=False, baseline=self.NOISY, worst=self.WORST), psp.EXIT_CANDIDATE_INADEQUATE, control)

    def test_the_inconclusive_exit_needs_a_baseline_over_the_bound(self) -> None:
        just_under = dict.fromkeys(("t1", "t2", "t3"), psp.HOST_BASELINE_BOUND_SECONDS)
        for baseline in (just_under, None, {}):
            self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=baseline, worst=self.WORST), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=self.NOISY, worst=None), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_stall_beyond_what_the_noise_explains_is_still_inadequate(self) -> None:
        """A real stall, on a host that is also noisy, must not read as noise:
        the worst statement is over the limit plus twice the baseline."""
        limit, baseline = psp.LATENCY_LIMIT_SECONDS, self.NOISY["t1"]
        edge = limit + 2 * baseline
        base = dict(self.NOISY)
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=base, worst={**self.WORST, "t1": edge - 0.001}), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=base, worst={**self.WORST, "t1": edge + 0.001}), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=base, worst={**self.WORST, "t2": 60.0}), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_quiet_tenant_that_stalls_is_inadequate_beside_a_noisy_one(self) -> None:
        baseline = {"t1": 0.02, "t2": 0.2, "t3": 0.2}
        worst = {"t1": 0.13, "t2": 0.3, "t3": 0.3}
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=baseline, worst=worst), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_one_noisy_failing_tenant_is_enough_when_the_others_pass(self) -> None:
        baseline = {"t1": 0.02, "t2": 0.02, "t3": psp.HOST_BASELINE_BOUND_SECONDS + 0.001}
        worst = {"t1": 0.03, "t2": 0.03, "t3": 0.15}
        self.assertEqual(psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=baseline, worst=worst), psp.EXIT_HOST_TOO_NOISY)

    def test_noise_is_judged_on_round_one_only(self) -> None:
        """Rounds after the first start on a host the earlier dumps may still
        be loading; only round 1 is untouched by a dump."""
        scenario = psp.Scenario()
        self.assertEqual(scenario.first_round_baseline, {})
        psp.record_round_baseline(scenario, 1, {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        psp.record_round_baseline(scenario, 2, {"t1": 0.30, "t2": 0.30, "t3": 0.30})
        self.assertEqual(scenario.first_round_baseline, {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        self.assertEqual(scenario.baseline, {"t1": 0.30, "t2": 0.30, "t3": 0.30})
        self.assertEqual(
            psp.exit_code(ONLY_CONTROL_2_FAILS, sabotaged=False, baseline=scenario.first_round_baseline, worst={"t1": 0.4, "t2": 0.4, "t3": 0.4}),
            psp.EXIT_CANDIDATE_INADEQUATE,
        )

    def test_a_sabotage_run_keeps_its_red_and_its_not_detected(self) -> None:
        red = {2: False, 3: False}
        self.assertEqual(psp.exit_code(red, sabotaged=True, baseline=self.NOISY, worst=self.WORST), psp.EXIT_RED)
        self.assertEqual(psp.exit_code({2: True}, sabotaged=True, baseline=self.NOISY, worst=self.WORST), psp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_a_failing_finding_is_not_hidden_either(self) -> None:
        self.assertEqual(psp.exit_code({**ALL_GREEN, 6: False}, sabotaged=False, baseline=self.NOISY, worst=self.WORST), psp.EXIT_FINDING_NOT_RECORDED)

    def test_an_inadequate_message_is_kept_for_a_real_failure(self) -> None:
        self.assertIn("CANDIDATE INADEQUATE", psp.outcome_message(psp.EXIT_CANDIDATE_INADEQUATE, "", self.NOISY))


if __name__ == "__main__":
    unittest.main()

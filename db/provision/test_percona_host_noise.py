#!/usr/bin/env python3
"""A host too slow to judge control 2 is inconclusive, never an inadequate
candidate. No Docker: the verdict and exit-code logic runs on the per-round
baselines and worst statements recorded from real runs
(percona_snapshot_probe_noisy_host.json)."""

from __future__ import annotations

import json
import pathlib
import unittest

import percona_snapshot_probe as psp
import snapshot_probe as sp

_FIXTURE = json.loads((pathlib.Path(__file__).resolve().parent / "percona_snapshot_probe_noisy_host.json").read_text(encoding="utf-8"))["runs"]

ALL_GREEN = {1: True, 2: True, 3: True, 4: True, 5: True, 6: True}
TENANTS = ("t1", "t2", "t3")


def readings(name: str) -> dict[int, psp.RoundReading]:
    return {number: psp.RoundReading(row["baseline"], row["worst"]) for number, row in enumerate(_FIXTURE[name]["rounds"], 1)}


def windows(name: str) -> dict[int, dict[str, list[float]]]:
    return {number: {tenant: [0.004, worst] for tenant, worst in row["worst"].items()} for number, row in enumerate(_FIXTURE[name]["rounds"], 1)}


def baselines(name: str) -> dict[int, dict[str, float]]:
    return {number: dict(row["baseline"]) for number, row in enumerate(_FIXTURE[name]["rounds"], 1)}


def exit_of(name: str, *, sabotaged: bool = False) -> int:
    """What the probe exits for a recorded run: control 2's verdict, then the exit code."""
    verdict = psp.windowed_latency_verdict(windows(name), psp.LATENCY_LIMIT_SECONDS, baselines(name))
    return psp.exit_code({**ALL_GREEN, 2: verdict.passed}, sabotaged=sabotaged, rounds=readings(name))


def reading(baseline: float, worst: float) -> psp.RoundReading:
    return psp.RoundReading(dict.fromkeys(TENANTS, baseline), dict.fromkeys(TENANTS, worst))


class RecordedRunsTests(unittest.TestCase):
    """Each point of the ruling, on a recorded run."""

    def test_a_host_that_degraded_after_round_1_is_inconclusive(self) -> None:
        self.assertEqual(exit_of("degraded_after_round_1"), psp.EXIT_HOST_TOO_NOISY)

    def test_a_quiet_baseline_with_a_real_stall_is_inadequate(self) -> None:
        self.assertEqual(exit_of("quiet_real_stall"), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_quiet_and_fast_run_passes(self) -> None:
        self.assertEqual(exit_of("quiet_fast"), psp.EXIT_PASSED)

    def test_the_older_slow_runner_runs_are_inconclusive(self) -> None:
        self.assertEqual(exit_of("noisy_all_rounds"), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(exit_of("noisy_all_rounds_second"), psp.EXIT_HOST_TOO_NOISY)

    def test_the_message_says_inconclusive_never_inadequate_and_names_the_rounds(self) -> None:
        message = psp.outcome_message(psp.EXIT_HOST_TOO_NOISY, "", readings("degraded_after_round_1"))
        self.assertIn("host too noisy: inconclusive", message)
        self.assertNotIn("INADEQUATE", message.upper())
        self.assertIn("round 2", message)
        self.assertIn("382.5 ms", message)
        self.assertNotIn("round 1", message)

    def test_an_inadequate_message_is_kept_for_a_real_failure(self) -> None:
        self.assertIn("CANDIDATE INADEQUATE", psp.outcome_message(psp.EXIT_CANDIDATE_INADEQUATE, "", readings("quiet_real_stall")))


class BoundAndLimitTests(unittest.TestCase):
    def test_the_bound_sits_between_the_quiet_runs_and_the_noisy_ones(self) -> None:
        quiet = max(max(row["baseline"].values()) for run in ("quiet_fast", "quiet_real_stall") for row in _FIXTURE[run]["rounds"])
        noisy = min(min(row["baseline"].values()) for row in _FIXTURE["noisy_all_rounds_second"]["rounds"])
        self.assertGreater(psp.HOST_BASELINE_BOUND_SECONDS, quiet)
        self.assertLess(psp.HOST_BASELINE_BOUND_SECONDS, noisy)
        self.assertLess(psp.HOST_BASELINE_BOUND_SECONDS, psp.LATENCY_LIMIT_SECONDS)

    def test_the_candidate_threshold_is_unchanged(self) -> None:
        self.assertEqual(psp.LATENCY_LIMIT_SECONDS, 0.100)
        self.assertEqual(sp.WRITER_LIMIT_SECONDS, 0.100)

    def test_the_inconclusive_exit_is_distinct(self) -> None:
        codes = {psp.EXIT_PASSED, psp.EXIT_RED, psp.EXIT_SABOTAGE_NOT_DETECTED, psp.EXIT_CANDIDATE_INADEQUATE, psp.EXIT_FINDING_NOT_RECORDED, psp.EXIT_REFUSED, 64}
        self.assertNotIn(psp.EXIT_HOST_TOO_NOISY, codes)


class PerRoundNoiseTests(unittest.TestCase):
    """Noise is judged on each judged round's own baseline."""

    QUIET_STALL = (0.02, 0.3)
    NOISY_STALL = (0.2, 0.4)

    def _exit(self, *rounds: psp.RoundReading) -> int:
        return psp.exit_code({**ALL_GREEN, 2: False}, sabotaged=False, rounds=dict(enumerate(rounds, 1)))

    def test_two_quiet_rounds_that_stall_are_inadequate_whatever_the_third_was(self) -> None:
        for noisy_round in (0, 1, 2):
            rounds = [reading(*self.QUIET_STALL)] * 3
            rounds[noisy_round] = reading(*self.NOISY_STALL)
            self.assertEqual(self._exit(*rounds), psp.EXIT_CANDIDATE_INADEQUATE, noisy_round)

    def test_fewer_than_two_quiet_rounds_is_inconclusive(self) -> None:
        for quiet_round in (0, 1, 2):
            rounds = [reading(*self.NOISY_STALL)] * 3
            rounds[quiet_round] = reading(*self.QUIET_STALL)
            self.assertEqual(self._exit(*rounds), psp.EXIT_HOST_TOO_NOISY, quiet_round)
        self.assertEqual(self._exit(*[reading(*self.NOISY_STALL)] * 3), psp.EXIT_HOST_TOO_NOISY)

    def test_a_quiet_round_that_passed_still_counts_as_quiet(self) -> None:
        self.assertEqual(self._exit(reading(0.02, 0.03), reading(*self.NOISY_STALL), reading(*self.NOISY_STALL)), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(self._exit(reading(0.02, 0.03), reading(0.02, 0.03), reading(*self.NOISY_STALL)), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_bound_is_strict_per_tenant(self) -> None:
        at_bound = psp.RoundReading(dict.fromkeys(TENANTS, psp.HOST_BASELINE_BOUND_SECONDS), dict.fromkeys(TENANTS, 0.15))
        over_one = psp.RoundReading({**at_bound.baseline, "t3": psp.HOST_BASELINE_BOUND_SECONDS + 0.001}, dict(at_bound.worst))
        self.assertEqual(self._exit(at_bound, at_bound, over_one), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertEqual(self._exit(at_bound, over_one, over_one), psp.EXIT_HOST_TOO_NOISY)

    def test_each_rounds_baseline_is_kept_by_round(self) -> None:
        scenario = psp.Scenario()
        psp.record_round_baseline(scenario, 1, {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        psp.record_round_baseline(scenario, 2, {"t1": 0.30, "t2": 0.30, "t3": 0.30})
        self.assertEqual(scenario.round_baselines[1], {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        self.assertEqual(scenario.round_baselines[2], {"t1": 0.30, "t2": 0.30, "t3": 0.30})


class HostNoiseSabotageTests(unittest.TestCase):
    """Each case would let a real candidate failure hide behind the new exit."""

    def test_a_stall_beyond_what_a_noisy_baseline_explains_is_trusted(self) -> None:
        """Noisy in baseline, but the worst statement is over the limit plus
        twice the baseline: the host does not explain it, so the round counts."""
        edge = psp.LATENCY_LIMIT_SECONDS + psp.HOST_NOISE_FACTOR * 0.2
        just_explained = reading(0.2, edge - 0.001)
        beyond = reading(0.2, edge + 0.001)
        exit_code = lambda *rounds: psp.exit_code({**ALL_GREEN, 2: False}, sabotaged=False, rounds=dict(enumerate(rounds, 1)))  # noqa: E731
        self.assertEqual(exit_code(just_explained, just_explained, just_explained), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(exit_code(just_explained, beyond, beyond), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_another_failed_control_is_still_inadequate_on_a_noisy_host(self) -> None:
        for control in (1, 3, 4, 5):
            outcomes = {**ALL_GREEN, 2: False, control: False}
            self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=readings("degraded_after_round_1")), psp.EXIT_CANDIDATE_INADEQUATE, control)

    def test_no_reading_or_a_blind_round_is_never_excused(self) -> None:
        outcomes = {**ALL_GREEN, 2: False}
        degraded = readings("degraded_after_round_1")
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=None), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds={}), psp.EXIT_CANDIDATE_INADEQUATE)
        blind = {**degraded, 3: psp.RoundReading(degraded[3].baseline, {"t1": 0.5})}
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=blind), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_sabotage_run_keeps_its_red_and_its_not_detected(self) -> None:
        degraded = readings("degraded_after_round_1")
        self.assertEqual(psp.exit_code({2: False, 3: False}, sabotaged=True, rounds=degraded), psp.EXIT_RED)
        self.assertEqual(psp.exit_code({2: True}, sabotaged=True, rounds=degraded), psp.EXIT_SABOTAGE_NOT_DETECTED)
        self.assertEqual(exit_of("degraded_after_round_1", sabotaged=True), psp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_the_global_lock_plan_is_one_judged_round_and_stays_red(self) -> None:
        self.assertEqual(sum(spec.long_round for spec in psp.PLANS["global-lock"]), 1)
        stalled = windows("quiet_real_stall")
        verdict = psp.windowed_latency_verdict({1: {"t1": [0.004, 10.1], "t2": [0.004, 9.9]}}, psp.LATENCY_LIMIT_SECONDS, {1: {"t1": 0.02, "t2": 0.02}})
        self.assertFalse(verdict.passed)
        self.assertEqual(len(stalled), 3)

    def test_a_failing_finding_is_not_hidden_either(self) -> None:
        self.assertEqual(psp.exit_code({**ALL_GREEN, 6: False}, sabotaged=False, rounds=readings("degraded_after_round_1")), psp.EXIT_FINDING_NOT_RECORDED)

    def test_a_noisy_run_that_still_passes_control_2_passes(self) -> None:
        self.assertEqual(psp.exit_code(ALL_GREEN, sabotaged=False, rounds=readings("degraded_after_round_1")), psp.EXIT_PASSED)


if __name__ == "__main__":
    unittest.main()

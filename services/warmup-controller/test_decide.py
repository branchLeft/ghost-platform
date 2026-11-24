"""`decide` against every gate, with an injected clock. Class and test names are the ones `sabotage.py` guards."""

from __future__ import annotations

import dataclasses
import unittest
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone

from scenarios import (
    NOW,
    TODAY,
    YESTERDAY,
    clean_evidence,
    clock,
    fixed,
    ready_state,
    with_day,
)
from warmup_controller.decide import NaiveClockError, decide, initial_state
from warmup_controller.model import (
    Action,
    ControllerState,
    DayEvidence,
    Deferral,
    Evidence,
    Feed,
    OwnerCards,
    ResumeCard,
    SeedPlacement,
)
from warmup_controller.stages import STAGES, DestinationGroup


class AdvanceTests(unittest.TestCase):
    def test_every_gate_clean_advances_one_stage(self) -> None:
        decision = decide(clean_evidence(), ready_state(), clock)
        self.assertEqual(decision.action, Action.ADVANCE)
        self.assertEqual(decision.state.stage, 2)
        self.assertEqual(decision.stage_before, 1)
        self.assertEqual(decision.state.stage_since, TODAY)
        self.assertEqual(decision.state.last_advance_day, TODAY)
        self.assertTrue(all(g.passed for g in decision.gates))
        self.assertEqual(decision.reasons, ())

    def test_each_stage_advances_when_its_own_half_cap_was_used(self) -> None:
        for caps in STAGES[:-1]:
            with self.subTest(stage=caps.stage):
                evidence = clean_evidence(real=caps.total // 2)
                if caps.stage >= 4:
                    evidence = dataclasses.replace(evidence, gmail_spam_rate_pct=0.02)
                decision = decide(evidence, ready_state(caps.stage), clock)
                self.assertEqual(decision.action, Action.ADVANCE)
                self.assertEqual(decision.state.stage, caps.stage + 1)

    def test_the_last_stage_never_advances(self) -> None:
        evidence = dataclasses.replace(clean_evidence(real=1600), gmail_spam_rate_pct=0.02)
        decision = decide(evidence, ready_state(7), clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertEqual(decision.state.stage, 7)
        self.assertIn("below_last_stage", decision.reasons)

    def test_a_spam_reading_with_no_date_holds_the_advance(self) -> None:
        # Postmaster's spam rate has no age of its own: a reading of unknown age must not pass.
        evidence = dataclasses.replace(clean_evidence(real=200), gmail_spam_rate_pct=0.05)
        decision = decide(evidence, ready_state(4), clock)
        self.assertNotEqual(decision.action, Action.ADVANCE)
        self.assertIn("evidence_fresh", decision.reasons)

    def test_a_spam_reading_older_than_48_hours_holds_the_advance(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=200),
            gmail_spam_rate_pct=0.05,
            gmail_spam_rate_at=NOW - timedelta(days=30),
        )
        decision = decide(evidence, ready_state(4), clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertEqual(decision.alerts, ("gmail_spam_rate:stale",))

    def test_a_spam_reading_within_48_hours_advances(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=200),
            gmail_spam_rate_pct=0.05,
            gmail_spam_rate_at=NOW - timedelta(hours=1),
        )
        self.assertEqual(decide(evidence, ready_state(4), clock).action, Action.ADVANCE)

    def test_a_second_run_on_the_same_day_does_not_advance_again(self) -> None:
        first = decide(clean_evidence(), ready_state(), clock)
        again = dataclasses.replace(first.state, stage_since=TODAY - timedelta(days=7))
        second = decide(clean_evidence(), again, clock)
        self.assertNotEqual(second.action, Action.ADVANCE)
        self.assertIn("once_per_day", second.reasons)


Spoil = Callable[[Evidence, ControllerState], tuple[Evidence, ControllerState]]


def _feed(feed: Feed, at: datetime | None) -> Spoil:
    def spoil(evidence: Evidence, state: ControllerState) -> tuple[Evidence, ControllerState]:
        return dataclasses.replace(evidence, feeds={**evidence.feeds, feed: at}), state

    return spoil


def _evidence(**changes: object) -> Spoil:
    def spoil(evidence: Evidence, state: ControllerState) -> tuple[Evidence, ControllerState]:
        return dataclasses.replace(evidence, **changes), state  # type: ignore[arg-type]

    return spoil


def _state(**changes: object) -> Spoil:
    def spoil(evidence: Evidence, state: ControllerState) -> tuple[Evidence, ControllerState]:
        return evidence, dataclasses.replace(state, **changes)  # type: ignore[arg-type]

    return spoil


def _bounces(count: int) -> Spoil:
    def spoil(evidence: Evidence, state: ControllerState) -> tuple[Evidence, ControllerState]:
        return with_day(evidence, YESTERDAY, hard_bounces=count), state

    return spoil


def _thin_days(count: int) -> Spoil:
    def spoil(evidence: Evidence, state: ControllerState) -> tuple[Evidence, ControllerState]:
        evidence = clean_evidence(real=30)
        for offset in range(1, count + 1):
            evidence = with_day(evidence, TODAY - timedelta(days=offset), real_sent=24)
        return evidence, state

    return spoil


class AdvanceGateTests(unittest.TestCase):
    """One gate failed at a time: the stage holds, and the ledger names the gate."""

    def hold(self, spoil: Spoil, gate: str, resets_window: bool) -> None:
        evidence, state = spoil(clean_evidence(real=50), ready_state())
        decision = decide(evidence, state, clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertIn(gate, decision.reasons)
        self.assertEqual(decision.state.stage, 1)
        expected = TODAY if resets_window else state.stage_since
        self.assertEqual(decision.state.stage_since, expected)

    def test_each_failed_gate_holds(self) -> None:
        cases: list[tuple[str, Spoil, str, bool]] = [
            (
                "six days at the stage",
                _state(stage_since=TODAY - timedelta(days=6)),
                "days_at_stage",
                False,
            ),
            ("bounces at 2 percent", _bounces(7), "hard_bounce_rate", True),
            ("spam at 0.10", _evidence(gmail_spam_rate_pct=0.10), "gmail_spam_rate", True),
            (
                "deferral 71 hours ago",
                _evidence(deferrals=(Deferral(DestinationGroup.GMAIL, NOW - timedelta(hours=71)),)),
                "no_deferral",
                True,
            ),
            (
                "seed placement not recorded",
                _evidence(seed_placement=SeedPlacement.NOT_RECORDED),
                "seed_placement",
                False,
            ),
            ("dmarc below 100", _evidence(dmarc_alignment_pct=99.0), "dmarc_alignment", True),
            ("dmarc no data", _evidence(dmarc_alignment_pct=None), "dmarc_alignment", False),
            ("only 3 days at half the cap", _thin_days(4), "evidence_floor", False),
        ]
        for name, spoil, gate, resets in cases:
            with self.subTest(name):
                self.hold(spoil, gate, resets)

    def test_stale_evidence_holds(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(),
            feeds={**clean_evidence().feeds, Feed.DELIVERY: NOW - timedelta(hours=49)},
        )
        decision = decide(evidence, ready_state(), clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertIn("evidence_fresh", decision.reasons)
        self.assertEqual(decision.alerts, ("delivery:stale",))

    def test_a_missing_feed_holds(self) -> None:
        for feed in Feed:
            with self.subTest(feed=feed):
                evidence = dataclasses.replace(
                    clean_evidence(), feeds={**clean_evidence().feeds, feed: None}
                )
                decision = decide(evidence, ready_state(), clock)
                self.assertEqual(decision.action, Action.HOLD)
                self.assertEqual(decision.alerts, (f"{feed.value}:missing",))

    def test_each_gate_passes_just_inside_its_limit(self) -> None:
        cases: list[tuple[str, Spoil]] = [
            ("six bounces in 350", _bounces(6)),
            ("spam at 0.09", _evidence(gmail_spam_rate_pct=0.09)),
            (
                "deferral at 72 hours",
                _evidence(deferrals=(Deferral(DestinationGroup.GMAIL, NOW - timedelta(hours=72)),)),
            ),
            ("feed at 48 hours", _feed(Feed.DMARC, NOW - timedelta(hours=48))),
            ("seven days at the stage", _state(stage_since=TODAY - timedelta(days=7))),
        ]
        for name, spoil in cases:
            with self.subTest(name):
                evidence, state = spoil(clean_evidence(real=50), ready_state())
                self.assertEqual(decide(evidence, state, clock).action, Action.ADVANCE)

    def test_exactly_four_days_at_half_the_cap_is_enough(self) -> None:
        evidence = clean_evidence(real=24)
        for offset in range(1, 5):
            evidence = with_day(evidence, TODAY - timedelta(days=offset), real_sent=25)
        self.assertEqual(decide(evidence, ready_state(), clock).action, Action.ADVANCE)

    def test_no_postmaster_data_is_enough_up_to_stage_3_and_not_from_stage_4(self) -> None:
        for stage, expected in ((3, Action.ADVANCE), (4, Action.HOLD)):
            with self.subTest(stage=stage):
                evidence = clean_evidence(real=STAGES[stage - 1].total // 2)
                decision = decide(evidence, ready_state(stage), clock)
                self.assertEqual(decision.action, expected)
                if expected == Action.HOLD:
                    self.assertIn("gmail_spam_rate", decision.reasons)
                    self.assertEqual(decision.state.stage_since, ready_state(stage).stage_since)


class NoRealMailTests(unittest.TestCase):
    """A day with no real mail is a wait. Seed mail moves nothing."""

    def test_a_day_with_no_real_mail_is_a_wait(self) -> None:
        evidence = with_day(clean_evidence(), YESTERDAY, real_sent=0)
        decision = decide(evidence, ready_state(), clock)
        self.assertEqual(decision.action, Action.WAIT)
        self.assertEqual(decision.reasons[0], "no_real_mail")
        self.assertEqual(decision.state, ready_state())

    def test_seed_mail_alone_never_advances(self) -> None:
        evidence = clean_evidence(real=0, seed=100)
        decision = decide(evidence, ready_state(), clock)
        self.assertEqual(decision.action, Action.WAIT)
        self.assertEqual(decision.state.stage, 1)

    def test_seed_mail_does_not_count_towards_the_evidence_floor(self) -> None:
        evidence = clean_evidence(real=10, seed=100)
        decision = decide(evidence, ready_state(), clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertIn("evidence_floor", decision.reasons)
        self.assertEqual(decision.state.stage, 1)

    def test_seed_mail_does_not_lift_the_cap(self) -> None:
        decision = decide(clean_evidence(real=0, seed=900), ready_state(4), clock)
        self.assertEqual(decision.effective_cap, 50)

    def test_three_real_readers_hold_for_months(self) -> None:
        state = initial_state(TODAY - timedelta(days=60))
        for offset in range(60, 0, -1):
            at = datetime.combine(TODAY - timedelta(days=offset - 1), NOW.timetz())
            decision = decide(clean_evidence(real=3, at=at), state, fixed(at))
            self.assertNotEqual(decision.action, Action.ADVANCE)
            state = decision.state
        self.assertEqual(state.stage, 1)

    def test_a_wait_does_not_restart_the_stage_window(self) -> None:
        evidence = clean_evidence(real=0)
        state = ready_state()
        self.assertEqual(decide(evidence, state, clock).state.stage_since, state.stage_since)


class StopTests(unittest.TestCase):
    def stop_for(self, evidence: Evidence, reason: str) -> None:
        decision = decide(evidence, ready_state(3), clock)
        self.assertEqual(decision.action, Action.STOP)
        self.assertTrue(decision.state.held)
        self.assertEqual(decision.state.stopped_at, NOW)
        self.assertEqual(decision.state.stop_reasons, (reason,))
        self.assertEqual(decision.state.stage, 3)

    def test_each_stop_class_event_stops_the_lane(self) -> None:
        base = clean_evidence(real=100)
        self.stop_for(dataclasses.replace(base, blocklisted_now=True), "blocklist")
        self.stop_for(dataclasses.replace(base, gmail_spam_rate_pct=0.30), "gmail_spam_rate")
        self.stop_for(with_day(base, YESTERDAY, rejections_5_7=5), "rejections_5_7_cluster")
        self.stop_for(dataclasses.replace(base, seed_placement=SeedPlacement.SPAM), "seed_in_spam")

    def test_just_under_each_stop_threshold_does_not_stop(self) -> None:
        base = clean_evidence(real=100)
        for evidence in (
            dataclasses.replace(base, gmail_spam_rate_pct=0.29),
            with_day(base, YESTERDAY, rejections_5_7=4),
        ):
            self.assertNotEqual(decide(evidence, ready_state(3), clock).action, Action.STOP)

    def test_a_stop_acts_on_stale_evidence_too(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            blocklisted_now=True,
            feeds={**clean_evidence().feeds, Feed.DMARC: None},
        )
        decision = decide(evidence, ready_state(3), clock)
        self.assertEqual(decision.action, Action.STOP)
        self.assertEqual(decision.alerts, ("dmarc:missing",))


def _stopped(
    *reasons: str, since: timedelta = timedelta(days=2), stage: int = 3
) -> ControllerState:
    return ControllerState(
        stage=stage,
        stage_since=TODAY - timedelta(days=10),
        held=True,
        stopped_at=NOW - since,
        stop_reasons=reasons,
    )


class ResumeTests(unittest.TestCase):
    def test_no_resume_without_the_card(self) -> None:
        for reasons in (("seed_in_spam",), ("gmail_spam_rate",), ("rejections_5_7_cluster",)):
            with self.subTest(reasons=reasons):
                decision = decide(clean_evidence(real=100), _stopped(*reasons), clock)
                self.assertEqual(decision.action, Action.HOLD)
                self.assertTrue(decision.state.held)
                self.assertIn("waiting_for_owner_card", decision.reasons)

    def test_the_card_resumes_one_stage_lower_with_a_fresh_window(self) -> None:
        stopped = _stopped("seed_in_spam")
        cards = OwnerCards(resume=ResumeCard(stopped_at=stopped.stopped_at or NOW))
        decision = decide(clean_evidence(real=100), stopped, clock, cards)
        self.assertEqual(decision.action, Action.RESUME)
        self.assertFalse(decision.state.held)
        self.assertEqual(decision.state.stage, 2)
        self.assertEqual(decision.state.stage_since, TODAY)
        self.assertIsNone(decision.state.stopped_at)

    def test_a_resume_never_goes_below_the_first_stage(self) -> None:
        stopped = _stopped("seed_in_spam", stage=1)
        cards = OwnerCards(resume=ResumeCard(stopped_at=stopped.stopped_at or NOW))
        self.assertEqual(decide(clean_evidence(), stopped, clock, cards).state.stage, 1)

    def test_a_card_for_an_earlier_stop_does_not_resume_a_later_one(self) -> None:
        cards = OwnerCards(resume=ResumeCard(stopped_at=NOW - timedelta(days=30)))
        decision = decide(clean_evidence(real=100), _stopped("seed_in_spam"), clock, cards)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertTrue(decision.state.held)

    def test_a_card_does_not_resume_while_the_condition_is_still_there(self) -> None:
        stopped = _stopped("blocklist")
        cards = OwnerCards(resume=ResumeCard(stopped_at=stopped.stopped_at or NOW))
        evidence = dataclasses.replace(clean_evidence(real=100), blocklisted_now=True)
        decision = decide(evidence, stopped, clock, cards)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertTrue(decision.state.held)

    def test_stale_evidence_blocks_a_resume_even_with_the_card(self) -> None:
        stopped = _stopped("seed_in_spam")
        cards = OwnerCards(resume=ResumeCard(stopped_at=stopped.stopped_at or NOW))
        evidence = dataclasses.replace(
            clean_evidence(real=100), feeds={**clean_evidence().feeds, Feed.BLOCKLIST: None}
        )
        decision = decide(evidence, stopped, clock, cards)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertEqual(decision.alerts, ("blocklist:missing",))

    def test_a_cleared_blocklist_resumes_alone_after_24_hours_one_stage_lower(self) -> None:
        decision = decide(
            clean_evidence(real=100), _stopped("blocklist", since=timedelta(hours=25)), clock
        )
        self.assertEqual(decision.action, Action.RESUME)
        self.assertEqual(decision.state.stage, 2)

    def test_a_cleared_blocklist_does_not_resume_before_24_hours(self) -> None:
        decision = decide(
            clean_evidence(real=100), _stopped("blocklist", since=timedelta(hours=23)), clock
        )
        self.assertEqual(decision.action, Action.HOLD)
        self.assertTrue(decision.state.held)

    def test_a_blocklist_stop_with_another_reason_needs_the_card(self) -> None:
        stopped = _stopped("blocklist", "seed_in_spam", since=timedelta(days=3))
        decision = decide(clean_evidence(real=100), stopped, clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertTrue(decision.state.held)


def _deferral(receiver: DestinationGroup, ago: timedelta) -> Deferral:
    return Deferral(receiver, NOW - ago)


class StepDownTests(unittest.TestCase):
    def test_one_deferral_holds_and_restarts_the_window(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            deferrals=(_deferral(DestinationGroup.GMAIL, timedelta(hours=2)),),
        )
        decision = decide(evidence, ready_state(3), clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertIn("no_deferral", decision.reasons)
        self.assertEqual(decision.state.stage, 3)
        self.assertEqual(decision.state.stage_since, TODAY)

    def test_a_second_deferral_from_one_receiver_in_a_week_drops_a_stage(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            deferrals=(
                _deferral(DestinationGroup.GMAIL, timedelta(days=5)),
                _deferral(DestinationGroup.GMAIL, timedelta(hours=2)),
            ),
        )
        decision = decide(evidence, ready_state(3), clock)
        self.assertEqual(decision.action, Action.STEP_DOWN)
        self.assertEqual(decision.state.stage, 2)
        self.assertEqual(decision.state.stage_since, TODAY)
        self.assertEqual(decision.state.last_step_down_at, NOW)
        self.assertEqual(decision.reasons, ("repeated_deferral:gmail",))

    def test_deferrals_from_different_receivers_do_not_add_up(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            deferrals=(
                _deferral(DestinationGroup.GMAIL, timedelta(days=2)),
                _deferral(DestinationGroup.YAHOO, timedelta(hours=2)),
            ),
        )
        self.assertNotEqual(decide(evidence, ready_state(3), clock).action, Action.STEP_DOWN)

    def test_deferrals_more_than_a_week_apart_do_not_add_up(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            deferrals=(
                _deferral(DestinationGroup.GMAIL, timedelta(days=8)),
                _deferral(DestinationGroup.GMAIL, timedelta(hours=2)),
            ),
        )
        self.assertNotEqual(decide(evidence, ready_state(3), clock).action, Action.STEP_DOWN)

    def test_the_same_deferrals_never_step_down_twice(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            deferrals=(
                _deferral(DestinationGroup.GMAIL, timedelta(days=5)),
                _deferral(DestinationGroup.GMAIL, timedelta(hours=2)),
            ),
        )
        first = decide(evidence, ready_state(3), clock)
        second = decide(evidence, first.state, clock)
        self.assertEqual(first.action, Action.STEP_DOWN)
        self.assertNotEqual(second.action, Action.STEP_DOWN)
        self.assertEqual(second.state.stage, 2)

    def test_two_new_deferrals_after_a_step_down_drop_another_stage(self) -> None:
        state = dataclasses.replace(ready_state(3), last_step_down_at=NOW - timedelta(days=1))
        evidence = dataclasses.replace(
            clean_evidence(real=100),
            deferrals=(
                _deferral(DestinationGroup.GMAIL, timedelta(hours=12)),
                _deferral(DestinationGroup.GMAIL, timedelta(hours=2)),
            ),
        )
        decision = decide(evidence, state, clock)
        self.assertEqual(decision.action, Action.STEP_DOWN)
        self.assertEqual(decision.state.stage, 2)

    def test_at_the_first_stage_there_is_no_lower_stage_to_drop_to(self) -> None:
        evidence = dataclasses.replace(
            clean_evidence(),
            deferrals=(
                _deferral(DestinationGroup.GMAIL, timedelta(days=5)),
                _deferral(DestinationGroup.GMAIL, timedelta(hours=2)),
            ),
        )
        decision = decide(evidence, ready_state(1), clock)
        self.assertEqual(decision.action, Action.HOLD)
        self.assertIn("already_at_first_stage", decision.reasons)
        self.assertEqual(decision.state.stage, 1)


class CeilingTests(unittest.TestCase):
    def cap(self, evidence: Evidence, stage: int = 4) -> int:
        young = dataclasses.replace(ready_state(stage), stage_since=TODAY)
        return decide(evidence, young, clock).effective_cap

    def test_cap_never_above_proven_volume(self) -> None:
        cap = self.cap(clean_evidence(real=60))
        self.assertEqual(cap, 90)
        self.assertLess(cap, STAGES[3].total)

    def test_one_and_a_half_times_the_best_clean_day_rounded_down(self) -> None:
        self.assertEqual(self.cap(clean_evidence(real=61)), 91)

    def test_the_floor_is_50(self) -> None:
        self.assertEqual(self.cap(clean_evidence(real=10)), 50)
        self.assertEqual(self.cap(clean_evidence(real=0)), 50)

    def test_the_stage_cap_is_the_other_limit(self) -> None:
        self.assertEqual(self.cap(clean_evidence(real=1000), stage=1), 50)
        self.assertEqual(self.cap(clean_evidence(real=1000), stage=2), 100)

    def test_a_day_that_was_not_clean_does_not_count(self) -> None:
        base = clean_evidence(real=60)
        cases = (
            with_day(base, YESTERDAY, real_sent=500, hard_bounces=20),
            with_day(base, YESTERDAY, real_sent=500, rejections_5_7=1),
            with_day(base, YESTERDAY, real_sent=500, blocklisted=True),
            dataclasses.replace(
                with_day(base, YESTERDAY, real_sent=500),
                deferrals=(Deferral(DestinationGroup.YAHOO, YESTERDAY_NOON),),
            ),
        )
        for evidence in cases:
            self.assertEqual(self.cap(evidence), 90)

    def test_only_the_last_14_days_count(self) -> None:
        old = with_day(clean_evidence(real=60), TODAY - timedelta(days=14), real_sent=100)
        self.assertEqual(self.cap(old), 150)
        base = clean_evidence(real=60)
        older = DayEvidence(day=TODAY - timedelta(days=15), real_sent=200)
        self.assertEqual(self.cap(dataclasses.replace(base, days=(older, *base.days))), 90)


YESTERDAY_NOON = datetime.combine(YESTERDAY, datetime.min.time(), tzinfo=UTC) + timedelta(hours=12)


class PurityTests(unittest.TestCase):
    def test_same_inputs_same_decision(self) -> None:
        self.assertEqual(
            decide(clean_evidence(), ready_state(), clock),
            decide(clean_evidence(), ready_state(), clock),
        )

    def test_the_inputs_are_not_changed(self) -> None:
        state = ready_state()
        decide(clean_evidence(), state, clock)
        self.assertEqual(state, ready_state())

    def test_a_clock_in_another_zone_decides_the_same(self) -> None:
        zone = timezone(timedelta(hours=-5))
        decision = decide(clean_evidence(), ready_state(), lambda: NOW.astimezone(zone))
        self.assertEqual(decision, decide(clean_evidence(), ready_state(), clock))

    def test_a_clock_with_no_timezone_is_refused(self) -> None:
        with self.assertRaises(NaiveClockError):
            decide(clean_evidence(), ready_state(), lambda: NOW.replace(tzinfo=None))


if __name__ == "__main__":
    unittest.main()

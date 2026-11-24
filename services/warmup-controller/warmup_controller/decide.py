"""`decide`: a day's evidence, the controller's state and a clock in; a decision out. No I/O, no mail. See ../README.md."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

from . import rules
from .model import (
    Action,
    ControllerState,
    Decision,
    Evidence,
    GateResult,
    OwnerCards,
)
from .stages import FIRST_STAGE

Clock = Callable[[], datetime]


def initial_state(today: date) -> ControllerState:
    """The state of a lane that has never been evaluated: the first stage, its window starting today."""
    return ControllerState(stage=FIRST_STAGE, stage_since=today)


def decide(
    evidence: Evidence,
    state: ControllerState,
    clock: Clock,
    cards: OwnerCards | None = None,
) -> Decision:
    """Advance, hold, wait, step down, stop or resume. Bad evidence holds; it never raises.

    The decision's state records that every complete day before today has been read.

    Raises:
        NaiveClockError: the clock returned a datetime with no timezone.
    """
    owner = cards if cards is not None else OwnerCards()
    now = _utc(clock())
    today = now.date()
    decision = _decide(evidence, state, owner, now, today)
    read_through = today - timedelta(days=1)
    return replace(decision, state=replace(decision.state, evaluated_through=read_through))


def _decide(
    evidence: Evidence,
    state: ControllerState,
    owner: OwnerCards,
    now: datetime,
    today: date,
) -> Decision:
    stops = rules.stop_reasons(evidence, today, state.evaluated_through)
    stale = rules.stale_feeds(evidence, now)

    if state.held:
        return _while_stopped(evidence, state, owner, now, today, stops, stale)

    if stops:
        stopped = replace(state, held=True, stopped_at=now, stop_reasons=stops)
        return _decision(today, Action.STOP, state, stopped, evidence, reasons=stops, alerts=stale)

    receiver = rules.repeated_deferral(evidence, state, now)
    if receiver is not None:
        return _step_down(evidence, state, now, today, receiver.value, stale)

    return _advance_or_hold(evidence, state, now, today, stale)


class NaiveClockError(ValueError):
    """The injected clock returned a datetime with no timezone."""


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        raise NaiveClockError
    return moment.astimezone(UTC)


def _decision(
    today: date,
    action: Action,
    before: ControllerState,
    after: ControllerState,
    evidence: Evidence,
    gates: tuple[GateResult, ...] = (),
    reasons: tuple[str, ...] = (),
    alerts: tuple[str, ...] = (),
) -> Decision:
    return Decision(
        day=today,
        action=action,
        stage_before=before.stage,
        state=after,
        effective_cap=rules.effective_cap(after.stage, evidence, today),
        gates=gates,
        reasons=reasons,
        alerts=alerts,
    )


def _while_stopped(
    evidence: Evidence,
    state: ControllerState,
    cards: OwnerCards,
    now: datetime,
    today: date,
    stops: tuple[str, ...],
    stale: tuple[str, ...],
) -> Decision:
    if stops:
        return _decision(
            today, Action.HOLD, state, state, evidence, reasons=("stopped", *stops), alerts=stale
        )
    if stale:
        return _decision(
            today,
            Action.HOLD,
            state,
            state,
            evidence,
            reasons=("stopped", "evidence_stale"),
            alerts=stale,
        )
    if not rules.resume_allowed(state, cards, evidence, now):
        return _decision(
            today,
            Action.HOLD,
            state,
            state,
            evidence,
            reasons=("stopped", "waiting_for_owner_card"),
        )
    resumed = replace(
        state,
        stage=max(FIRST_STAGE, state.stage - 1),
        stage_since=today,
        held=False,
        stopped_at=None,
        stop_reasons=(),
    )
    return _decision(today, Action.RESUME, state, resumed, evidence, reasons=state.stop_reasons)


def _step_down(
    evidence: Evidence,
    state: ControllerState,
    now: datetime,
    today: date,
    receiver: str,
    stale: tuple[str, ...],
) -> Decision:
    reasons = (f"repeated_deferral:{receiver}",)
    lower = max(FIRST_STAGE, state.stage - 1)
    after = replace(state, stage=lower, stage_since=today, last_step_down_at=now)
    if lower == state.stage:
        return _decision(
            today,
            Action.HOLD,
            state,
            replace(after, stage_since=state.stage_since),
            evidence,
            reasons=(*reasons, "already_at_first_stage"),
            alerts=stale,
        )
    return _decision(today, Action.STEP_DOWN, state, after, evidence, reasons=reasons, alerts=stale)


def _advance_or_hold(
    evidence: Evidence,
    state: ControllerState,
    now: datetime,
    today: date,
    stale: tuple[str, ...],
) -> Decision:
    gates = rules.advance_gates(state, evidence, now, today)
    failed = tuple(g for g in gates if not g.passed)
    no_real_mail = rules.counted_volume(evidence.day(today - timedelta(days=1))) == 0

    if no_real_mail:
        return _decision(
            today,
            Action.WAIT,
            state,
            state,
            evidence,
            gates=gates,
            reasons=("no_real_mail", *(g.name for g in failed)),
            alerts=stale,
        )
    if failed:
        after = state
        if any(g.resets_window for g in failed):
            after = replace(state, stage_since=today)
        return _decision(
            today,
            Action.HOLD,
            state,
            after,
            evidence,
            gates=gates,
            reasons=tuple(g.name for g in failed),
            alerts=stale,
        )
    after = replace(state, stage=state.stage + 1, stage_since=today, last_advance_day=today)
    return _decision(today, Action.ADVANCE, state, after, evidence, gates=gates)

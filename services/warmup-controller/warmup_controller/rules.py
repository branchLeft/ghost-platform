"""The gate values and the pure checks `decide` is built from. Each is named so a sabotage run can break it alone. See ../README.md."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from .model import (
    ControllerState,
    DayEvidence,
    Deferral,
    Evidence,
    Feed,
    GateResult,
    OwnerCards,
    SeedPlacement,
)
from .stages import LAST_STAGE, DestinationGroup, caps_for

MIN_DAYS_AT_STAGE = 7
HARD_BOUNCE_MAX_PCT = 2.0
GMAIL_SPAM_ADVANCE_BELOW_PCT = 0.10
GMAIL_SPAM_STOP_AT_PCT = 0.30
DEFERRAL_QUIET_HOURS = 72
STALE_AFTER_HOURS = 48
CEILING_MULTIPLIER_PERCENT = 150
CEILING_WINDOW_DAYS = 14
CEILING_FLOOR = 50
EXERCISE_WINDOW_DAYS = 7
EXERCISE_DAYS_REQUIRED = 4
REJECTION_CLUSTER = 5
BLOCKLIST_RESUME_HOURS = 24
STEP_DOWN_WINDOW_DAYS = 7
STOP_LOOKBACK_DAYS = 7
STEP_DOWN_DEFERRALS = 2
POSTMASTER_REQUIRED_FROM_STAGE = 4
DMARC_REQUIRED_PCT = 100.0

BLOCKLIST = "blocklist"
GMAIL_SPAM_RATE = "gmail_spam_rate"
REJECTION_CLUSTER_REASON = "rejections_5_7_cluster"
SEED_IN_SPAM = "seed_in_spam"


def counted_volume(day: DayEvidence) -> int:
    """The volume a gate may count: real mail only. Seed mail is never counted."""
    return day.real_sent


def window(today: date, days: int) -> tuple[date, ...]:
    """The `days` complete UTC days before `today`, oldest first."""
    return tuple(today - timedelta(days=offset) for offset in range(days, 0, -1))


def stale_feeds(evidence: Evidence, now: datetime) -> tuple[str, ...]:
    """Feeds that are missing or older than the freshness limit, as `feed:missing` or `feed:stale`."""
    problems: list[str] = []
    for feed in Feed:
        updated = evidence.feeds.get(feed)
        if updated is None:
            problems.append(f"{feed.value}:missing")
        elif now - updated > timedelta(hours=STALE_AFTER_HOURS):
            problems.append(f"{feed.value}:stale")
    if evidence.gmail_spam_rate_pct is not None:
        taken = evidence.gmail_spam_rate_at
        if taken is None or now - taken > timedelta(hours=STALE_AFTER_HOURS):
            problems.append("gmail_spam_rate:stale")
    return tuple(problems)


def stop_days(today: date, evaluated_through: date | None) -> tuple[date, ...]:
    """The complete days a stop reads: every day after the last one a run read, or the last week on a first run."""
    if evaluated_through is None:
        return window(today, STOP_LOOKBACK_DAYS)
    count = (today - timedelta(days=1) - evaluated_through).days
    return tuple(evaluated_through + timedelta(days=offset) for offset in range(1, count + 1))


def deferrals_on(evidence: Evidence, when: date) -> tuple[Deferral, ...]:
    return tuple(d for d in evidence.deferrals if d.at.date() == when)


def day_is_clean(day: DayEvidence, evidence: Evidence) -> bool:
    """A day with real mail that passed every per-day gate."""
    if counted_volume(day) <= 0:
        return False
    return (
        day.hard_bounces * 100 < HARD_BOUNCE_MAX_PCT * counted_volume(day)
        and day.rejections_5_7 == 0
        and not day.blocklisted
        and not deferrals_on(evidence, day.day)
    )


def proven_ceiling(evidence: Evidence, today: date) -> int:
    """1.5 times the highest clean real day in the last 14, never below the floor."""
    best = max(
        (
            counted_volume(evidence.day(d))
            for d in window(today, CEILING_WINDOW_DAYS)
            if day_is_clean(evidence.day(d), evidence)
        ),
        default=0,
    )
    return max(CEILING_FLOOR, best * CEILING_MULTIPLIER_PERCENT // 100)


def effective_cap(stage: int, evidence: Evidence, today: date) -> int:
    """The day's cap: the stage's, held down to what has been proven clean."""
    return min(caps_for(stage).total, proven_ceiling(evidence, today))


def stop_reasons(
    evidence: Evidence, today: date, evaluated_through: date | None
) -> tuple[str, ...]:
    """Stop-class conditions in the evidence: the current listing, and any day since the last run's read."""
    days = [evidence.day(when) for when in stop_days(today, evaluated_through)]
    reasons: list[str] = []
    if evidence.blocklisted_now or any(day.blocklisted for day in days):
        reasons.append(BLOCKLIST)
    if (
        evidence.gmail_spam_rate_pct is not None
        and evidence.gmail_spam_rate_pct >= GMAIL_SPAM_STOP_AT_PCT
    ):
        reasons.append(GMAIL_SPAM_RATE)
    if any(day.rejections_5_7 >= REJECTION_CLUSTER for day in days):
        reasons.append(REJECTION_CLUSTER_REASON)
    if evidence.seed_placement == SeedPlacement.SPAM:
        reasons.append(SEED_IN_SPAM)
    return tuple(reasons)


def resume_allowed(
    state: ControllerState, cards: OwnerCards, evidence: Evidence, now: datetime
) -> bool:
    """A stop lifts on the owner's card for that stop, or alone when only a blocklist listing stopped it and it has cleared for a day."""
    if state.stopped_at is None:
        return False
    if cards.resume is not None and cards.resume.stopped_at == state.stopped_at:
        return True
    return (
        state.stop_reasons == (BLOCKLIST,)
        and not evidence.blocklisted_now
        and now - state.stopped_at >= timedelta(hours=BLOCKLIST_RESUME_HOURS)
    )


def repeated_deferral(
    evidence: Evidence, state: ControllerState, now: datetime
) -> DestinationGroup | None:
    """A receiver that deferred again within a week, counting only deferrals since the last step down."""
    since = now - timedelta(days=STEP_DOWN_WINDOW_DAYS)
    if state.last_step_down_at is not None:
        since = max(since, state.last_step_down_at)
    for receiver in DestinationGroup:
        recent = [d for d in evidence.deferrals if d.receiver == receiver and since < d.at <= now]
        if len(recent) >= STEP_DOWN_DEFERRALS:
            return receiver
    return None


def exercised_days(evidence: Evidence, stage: int, today: date) -> int:
    """Days in the last week on which real mail reached half the stage's cap."""
    half = caps_for(stage).total // 2
    return sum(
        1 for d in window(today, EXERCISE_WINDOW_DAYS) if counted_volume(evidence.day(d)) >= half
    )


def advance_gates(
    state: ControllerState, evidence: Evidence, now: datetime, today: date
) -> tuple[GateResult, ...]:
    """Every advance gate with the value it read. All must pass, once a UTC day, for a stage to move."""
    days = [evidence.day(d) for d in window(today, EXERCISE_WINDOW_DAYS)]
    real = sum(counted_volume(d) for d in days)
    bounces = sum(d.hard_bounces for d in days)
    exercised = exercised_days(evidence, state.stage, today)
    stale = stale_feeds(evidence, now)
    recent_deferral = any(
        now - d.at < timedelta(hours=DEFERRAL_QUIET_HOURS) for d in evidence.deferrals
    )
    spam = evidence.gmail_spam_rate_pct
    needs_data = state.stage >= POSTMASTER_REQUIRED_FROM_STAGE
    spam_ok = (spam is None and not needs_data) or (
        spam is not None and spam < GMAIL_SPAM_ADVANCE_BELOW_PCT
    )
    dmarc = evidence.dmarc_alignment_pct
    return (
        GateResult(
            "evidence_fresh", not stale, ",".join(stale) or "fresh", f"within {STALE_AFTER_HOURS}h"
        ),
        GateResult(
            "days_at_stage",
            (today - state.stage_since).days >= MIN_DAYS_AT_STAGE,
            str((today - state.stage_since).days),
            f">= {MIN_DAYS_AT_STAGE}",
        ),
        GateResult(
            "hard_bounce_rate",
            bounces == 0 or bounces * 100 < HARD_BOUNCE_MAX_PCT * real,
            f"{bounces} of {real}",
            f"< {HARD_BOUNCE_MAX_PCT}%",
            resets_window=True,
        ),
        GateResult(
            "gmail_spam_rate",
            spam_ok,
            "no data" if spam is None else f"{spam}%",
            f"< {GMAIL_SPAM_ADVANCE_BELOW_PCT}%" + (", data required" if needs_data else ""),
            resets_window=spam is not None,
        ),
        GateResult(
            "no_deferral",
            not recent_deferral,
            "deferred" if recent_deferral else "none",
            f"none in {DEFERRAL_QUIET_HOURS}h",
            resets_window=True,
        ),
        GateResult(
            "not_blocklisted",
            not evidence.blocklisted_now,
            "listed" if evidence.blocklisted_now else "clear",
            "clear",
            resets_window=True,
        ),
        GateResult(
            "seed_placement",
            evidence.seed_placement == SeedPlacement.INBOX,
            evidence.seed_placement.value,
            "inbox",
            resets_window=evidence.seed_placement == SeedPlacement.SPAM,
        ),
        GateResult(
            "dmarc_alignment",
            dmarc is not None and dmarc >= DMARC_REQUIRED_PCT,
            "no data" if dmarc is None else f"{dmarc}%",
            f"{DMARC_REQUIRED_PCT}%",
            resets_window=dmarc is not None,
        ),
        GateResult(
            "evidence_floor",
            exercised >= EXERCISE_DAYS_REQUIRED,
            f"{exercised} of {EXERCISE_WINDOW_DAYS} days",
            f">= {EXERCISE_DAYS_REQUIRED} days at half the stage cap, real mail only",
        ),
        GateResult(
            "below_last_stage",
            state.stage < LAST_STAGE,
            str(state.stage),
            f"< {LAST_STAGE}",
        ),
        GateResult(
            "once_per_day",
            state.last_advance_day != today,
            "advanced today" if state.last_advance_day == today else "not yet",
            "one advance per UTC day",
        ),
    )

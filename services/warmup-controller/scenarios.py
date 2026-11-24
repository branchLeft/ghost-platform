"""Builders for the tests: a lane at stage 1 with a clean week behind it, which each test then spoils one way."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

from warmup_controller.model import (
    ControllerState,
    DayEvidence,
    Evidence,
    Feed,
    SeedPlacement,
)

NOW = datetime(2026, 12, 10, 6, 0, tzinfo=UTC)
TODAY = NOW.date()
YESTERDAY = TODAY - timedelta(days=1)


def clock() -> datetime:
    return NOW


def fixed(at: datetime) -> Callable[[], datetime]:
    return lambda: at


def fresh_feeds(at: datetime = NOW) -> dict[Feed, datetime | None]:
    return {feed: at - timedelta(hours=1) for feed in Feed}


def days(
    real: int = 30, seed: int = 0, count: int = 14, today: date = TODAY
) -> tuple[DayEvidence, ...]:
    """`count` complete days before `today`, each with the same real and seed volume, oldest first."""
    return tuple(
        DayEvidence(day=today - timedelta(days=offset), real_sent=real, seed_sent=seed)
        for offset in range(count, 0, -1)
    )


def clean_evidence(real: int = 30, seed: int = 0, at: datetime = NOW) -> Evidence:
    return Evidence(
        feeds=fresh_feeds(at),
        days=days(real, seed, today=at.date()),
        seed_placement=SeedPlacement.INBOX,
        dmarc_alignment_pct=100.0,
    )


def with_day(evidence: Evidence, when: date, **changes: int | bool) -> Evidence:
    """The same evidence with one day's row changed."""
    rows = tuple(
        DayEvidence(
            day=row.day,
            real_sent=int(changes.get("real_sent", row.real_sent)),
            seed_sent=int(changes.get("seed_sent", row.seed_sent)),
            hard_bounces=int(changes.get("hard_bounces", row.hard_bounces)),
            rejections_5_7=int(changes.get("rejections_5_7", row.rejections_5_7)),
            blocklisted=bool(changes.get("blocklisted", row.blocklisted)),
        )
        if row.day == when
        else row
        for row in evidence.days
    )
    return Evidence(
        feeds=evidence.feeds,
        days=rows,
        deferrals=evidence.deferrals,
        blocklisted_now=evidence.blocklisted_now,
        seed_placement=evidence.seed_placement,
        dmarc_alignment_pct=evidence.dmarc_alignment_pct,
        gmail_spam_rate_pct=evidence.gmail_spam_rate_pct,
    )


def ready_state(stage: int = 1) -> ControllerState:
    """A lane whose stage has run its 7 days."""
    return ControllerState(stage=stage, stage_since=TODAY - timedelta(days=7))

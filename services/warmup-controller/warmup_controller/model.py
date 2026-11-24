"""What the controller reads and what it decides. Plain frozen data: nothing here does I/O."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum

from .stages import DestinationGroup


class Feed(StrEnum):
    """An evidence feed the advance gates cannot be judged without. A missing or old one holds."""

    DELIVERY = "delivery"
    BLOCKLIST = "blocklist"
    SEED_PLACEMENT = "seed_placement"
    DMARC = "dmarc"


class SeedPlacement(StrEnum):
    """Where a person recorded a seed subscriber's copy of a real newsletter. Reading only: nothing is opened or rescued."""

    INBOX = "inbox"
    SPAM = "spam"
    NOT_RECORDED = "not_recorded"


class Action(StrEnum):
    ADVANCE = "advance"
    HOLD = "hold"
    # A day with no real mail: nothing to judge, so nothing moves.
    WAIT = "wait"
    STEP_DOWN = "step_down"
    STOP = "stop"
    RESUME = "resume"


@dataclass(frozen=True)
class DayEvidence:
    """One UTC day on the newsletter lane.

    `real_sent` is mail to real subscribers who expect it. `seed_sent` is mail
    to the platform's own test or seed addresses. Only `real_sent` is ever
    counted towards a gate; `seed_sent` is carried so the ledger can show it
    was seen and ignored.
    """

    day: date
    real_sent: int = 0
    seed_sent: int = 0
    hard_bounces: int = 0
    # 5.7.x rejections that day.
    rejections_5_7: int = 0
    # The hourly blocklist check found IP2 listed at any hour of the day.
    blocklisted: bool = False


@dataclass(frozen=True)
class Deferral:
    """A 4.7.28, 451 4.7.650 or Yahoo TS deferral, with the receiver that sent it."""

    receiver: DestinationGroup
    at: datetime


@dataclass(frozen=True)
class Evidence:
    # When each feed was last updated; None when the feed is missing.
    feeds: Mapping[Feed, datetime | None]
    days: tuple[DayEvidence, ...]
    deferrals: tuple[Deferral, ...] = ()
    # The newest hourly blocklist reading.
    blocklisted_now: bool = False
    seed_placement: SeedPlacement = SeedPlacement.NOT_RECORDED
    # Own-domain DMARC alignment over the window; None while the reader has no report.
    dmarc_alignment_pct: float | None = None
    # Gmail spam rate from Postmaster Tools; None while Postmaster shows no data (it goes blank at low volume).
    gmail_spam_rate_pct: float | None = None

    def day(self, when: date) -> DayEvidence:
        """The evidence for one day; a day the feed has no row for sent nothing."""
        for entry in self.days:
            if entry.day == when:
                return entry
        return DayEvidence(day=when)


@dataclass(frozen=True)
class ResumeCard:
    """The owner's answer on a stop card. It names the stop it answers, so an old card cannot resume a new stop."""

    stopped_at: datetime


@dataclass(frozen=True)
class OwnerCards:
    resume: ResumeCard | None = None


@dataclass(frozen=True)
class ControllerState:
    """The controller's own memory between runs. The collector reads none of it (see `PublishedState`)."""

    stage: int
    stage_since: date
    held: bool = False
    destination_holds: tuple[DestinationGroup, ...] = ()
    # Advance is evaluated once per UTC day.
    last_advance_day: date | None = None
    stopped_at: datetime | None = None
    stop_reasons: tuple[str, ...] = ()
    last_step_down_at: datetime | None = None


@dataclass(frozen=True)
class GateResult:
    name: str
    passed: bool
    value: str
    threshold: str
    # A failed gate of this kind restarts the stage's 7-day window.
    resets_window: bool = False


@dataclass(frozen=True)
class Decision:
    day: date
    action: Action
    stage_before: int
    state: ControllerState
    effective_cap: int
    gates: tuple[GateResult, ...] = ()
    reasons: tuple[str, ...] = ()
    # Conditions a person should hear about, never a reason by itself to act: stale or missing feeds.
    alerts: tuple[str, ...] = ()

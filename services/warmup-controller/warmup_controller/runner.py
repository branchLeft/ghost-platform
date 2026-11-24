"""One run: read the files, decide, record, write. The evidence is fetched by the caller. See ../README.md."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import rules
from .decide import Clock, decide, initial_state
from .model import Action, ControllerState, Decision, Evidence, OwnerCards
from .store import (
    Ledger,
    LedgerError,
    ledger_row,
    load_state,
    published_from,
    save_state,
    write_published,
)

# A stop or a step down protects the lane. Its collector file is written before its ledger row,
# so a ledger fault cannot hold the protection back.
_PROTECTIVE = frozenset({Action.STOP, Action.STEP_DOWN})


@dataclass(frozen=True)
class Paths:
    controller_state: Path
    published_state: Path
    ledger: Path


def run_once(
    evidence: Evidence, clock: Clock, paths: Paths, cards: OwnerCards | None = None
) -> Decision:
    """Decides, then records and writes the controller's state and the collector's file.

    Every other decision: the ledger row comes first, so a run that cannot record why changes
    nothing. A protective decision (stop, step down) is published and saved first; its ledger row
    is best effort, and a row that cannot be written is an alert on the returned decision.
    A state file that exists and cannot be read stops the run before any write.
    """
    now = clock().astimezone(UTC)
    state = load_state(paths.controller_state) or initial_state(now.date())
    decision = decide(evidence, state, lambda: now, cards)
    ledger = Ledger(paths.ledger)

    if decision.action in _PROTECTIVE:
        _write_files(paths, decision)
        try:
            _record(ledger, decision, state, now, evidence)
        except LedgerError:
            return replace(decision, alerts=(*decision.alerts, "ledger_unwritable"))
        return decision

    _record(ledger, decision, state, now, evidence)
    _write_files(paths, decision)
    return decision


def _record(
    ledger: Ledger,
    decision: Decision,
    state: ControllerState,
    now: datetime,
    evidence: Evidence,
) -> None:
    """Appends the day's daily row, or an event row for a state change the daily row did not record."""
    if ledger.has_daily(decision.day):
        if decision.state == state:
            return
        kind = "event"
    else:
        kind = "daily"
    yesterday = evidence.day(now.date() - timedelta(days=1))
    ledger.append(
        ledger_row(decision, kind, now, rules.counted_volume(yesterday), yesterday.seed_sent)
    )


def _write_files(paths: Paths, decision: Decision) -> None:
    # The collector's file first: a run that stops after this and before the state is saved is
    # safe to repeat, because the decision is a pure function of the state it read.
    write_published(paths.published_state, published_from(decision))
    save_state(paths.controller_state, decision.state)

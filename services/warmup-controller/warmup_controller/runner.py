"""One run: read the files, decide, record, write. The evidence is fetched by the caller. See ../README.md."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, timedelta
from pathlib import Path

from . import rules
from .decide import Clock, decide, initial_state
from .model import Action, Decision, Evidence, OwnerCards
from .store import Ledger, ledger_row, load_state, published_from, save_state, write_published

_RECORDED_BETWEEN_DAILY_ROWS = frozenset({Action.STEP_DOWN, Action.STOP, Action.RESUME})


@dataclass(frozen=True)
class Paths:
    controller_state: Path
    published_state: Path
    ledger: Path


def run_once(
    evidence: Evidence, clock: Clock, paths: Paths, cards: OwnerCards | None = None
) -> Decision:
    """Decides, appends the ledger row, then writes the controller's state and the collector's file.

    The ledger comes first: a run that cannot record why changes nothing. A
    state file that exists and cannot be read stops the run before any write.
    """
    now = clock().astimezone(UTC)
    state = load_state(paths.controller_state) or initial_state(now.date())
    decision = decide(evidence, state, lambda: now, cards)

    yesterday = evidence.day(now.date() - timedelta(days=1))
    ledger = Ledger(paths.ledger)
    row_kind = None
    if not ledger.has_daily(decision.day):
        row_kind = "daily"
    elif decision.action in _RECORDED_BETWEEN_DAILY_ROWS:
        row_kind = "event"
    if row_kind is not None:
        ledger.append(
            ledger_row(
                decision, row_kind, now, rules.counted_volume(yesterday), yesterday.seed_sent
            )
        )

    # The collector's file first: a run that stops after this and before the state is saved is
    # safe to repeat, because the decision is a pure function of the state it read.
    write_published(paths.published_state, published_from(decision))
    save_state(paths.controller_state, decision.state)
    return decision

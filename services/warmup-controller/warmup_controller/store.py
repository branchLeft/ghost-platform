"""The two state files and the ledger. Files are written whole and renamed into place; the ledger is only ever appended to. See ../README.md."""

from __future__ import annotations

import fcntl
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from .model import ControllerState, Decision
from .stages import DestinationGroup, UnknownStageError, caps_for

JsonObject = Mapping[str, object]


class StateCorruptError(Exception):
    """A state file is there and cannot be trusted. Nothing is written until a person has looked."""

    def __init__(self, field: str, expected: str) -> None:
        super().__init__(f"{field}: expected {expected}")


class LedgerError(Exception):
    """The ledger cannot be appended to, and nothing was written."""

    def __init__(self, problem: str, where: object = "") -> None:
        super().__init__(f"{problem} {where}".strip())


def _known_stage(stage: int) -> None:
    try:
        caps_for(stage)
    except UnknownStageError as error:
        raise StateCorruptError("stage", "known_stage") from error


def write_json_atomic(path: Path, payload: JsonObject) -> None:
    """Writes `payload` whole to a sibling file, then renames it over `path`: a reader never sees half a file."""
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


@dataclass(frozen=True)
class PublishedState:
    """What the mail collector reads: its own three keys, plus the day's cap held to proven volume."""

    stage: int
    held: bool
    destination_holds: tuple[DestinationGroup, ...]
    effective_cap: int

    def to_json(self) -> JsonObject:
        return {
            "stage": self.stage,
            "held": self.held,
            "destinationHolds": [group.value for group in self.destination_holds],
            "effectiveCap": self.effective_cap,
        }


def published_from(decision: Decision) -> PublishedState:
    state = decision.state
    return PublishedState(state.stage, state.held, state.destination_holds, decision.effective_cap)


def parse_published(raw: object) -> PublishedState:
    """Reads a published file as the collector does: exactly, or not at all.

    Raises:
        StateCorruptError: any key is missing or not what the collector accepts.
    """
    if not isinstance(raw, dict):
        raise StateCorruptError("state", "object")
    stage = raw.get("stage")
    held = raw.get("held")
    holds = raw.get("destinationHolds")
    cap = raw.get("effectiveCap")
    if not isinstance(stage, int) or isinstance(stage, bool):
        raise StateCorruptError("stage", "integer")
    _known_stage(stage)
    if not isinstance(held, bool):
        raise StateCorruptError("held", "boolean")
    if not isinstance(holds, list):
        raise StateCorruptError("destinationHolds", "array")
    if not isinstance(cap, int) or isinstance(cap, bool) or cap < 0:
        raise StateCorruptError("effectiveCap", "count")
    try:
        groups = tuple(DestinationGroup(entry) for entry in holds)
    except ValueError as error:
        raise StateCorruptError("destinationHolds", "known_group") from error
    return PublishedState(stage, held, groups, cap)


def write_published(path: Path, published: PublishedState) -> None:
    write_json_atomic(path, published.to_json())


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def _date(value: object, name: str) -> date:
    if not isinstance(value, str):
        raise StateCorruptError(name, "date")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise StateCorruptError(name, "date") from error


def _moment(value: object, name: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise StateCorruptError(name, "timestamp")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise StateCorruptError(name, "timestamp") from error
    if parsed.tzinfo is None:
        raise StateCorruptError(name, "timezone")
    return parsed


def state_to_json(state: ControllerState) -> JsonObject:
    return {
        "version": 1,
        "stage": state.stage,
        "held": state.held,
        "destinationHolds": [group.value for group in state.destination_holds],
        "stageSince": state.stage_since.isoformat(),
        "lastAdvanceDay": None
        if state.last_advance_day is None
        else state.last_advance_day.isoformat(),
        "stoppedAt": _iso(state.stopped_at),
        "stopReasons": list(state.stop_reasons),
        "lastStepDownAt": _iso(state.last_step_down_at),
    }


def state_from_json(raw: object) -> ControllerState:
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise StateCorruptError("state", "versioned_object")
    stage = raw.get("stage")
    held = raw.get("held")
    holds = raw.get("destinationHolds")
    reasons = raw.get("stopReasons")
    if not isinstance(stage, int) or isinstance(stage, bool):
        raise StateCorruptError("stage", "integer")
    _known_stage(stage)
    if not isinstance(held, bool):
        raise StateCorruptError("held", "boolean")
    if not isinstance(holds, list) or not isinstance(reasons, list):
        raise StateCorruptError("stopReasons", "array")
    if not all(isinstance(reason, str) for reason in reasons):
        raise StateCorruptError("stopReasons", "strings")
    try:
        groups = tuple(DestinationGroup(entry) for entry in holds)
    except ValueError as error:
        raise StateCorruptError("destinationHolds", "known_group") from error
    last_advance = raw.get("lastAdvanceDay")
    return ControllerState(
        stage=stage,
        stage_since=_date(raw.get("stageSince"), "stageSince"),
        held=held,
        destination_holds=groups,
        last_advance_day=None if last_advance is None else _date(last_advance, "lastAdvanceDay"),
        stopped_at=_moment(raw.get("stoppedAt"), "stoppedAt"),
        stop_reasons=tuple(str(reason) for reason in reasons),
        last_step_down_at=_moment(raw.get("lastStepDownAt"), "lastStepDownAt"),
    )


def load_state(path: Path) -> ControllerState | None:
    """None only when there is no file (a first run).

    Raises:
        StateCorruptError: the file is there and cannot be read exactly.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        return state_from_json(json.loads(text))
    except json.JSONDecodeError as error:
        raise StateCorruptError("state", "json") from error


def save_state(path: Path, state: ControllerState) -> None:
    write_json_atomic(path, state_to_json(state))


class Ledger:
    """One JSON line per row, appended and never rewritten. A UTC day has one `daily` row; `event` rows add to it."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def rows(self) -> list[JsonObject]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        if text and not text.endswith("\n"):
            raise LedgerError("half_written_row")
        rows: list[JsonObject] = []
        for number, line in enumerate(text.splitlines(), start=1):
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise LedgerError("not_json", number) from error
            if not isinstance(row, dict):
                raise LedgerError("not_an_object", number)
            rows.append(row)
        return rows

    def has_daily(self, day: date) -> bool:
        return any(
            r.get("kind") == "daily" and r.get("day") == day.isoformat() for r in self.rows()
        )

    def append(self, row: JsonObject) -> None:
        """Adds one row at the end.

        Raises:
            LedgerError: a `daily` row for that day exists, or the ledger cannot be read whole.
        """
        existing = self.rows()
        day = row.get("day")
        if row.get("kind") == "daily" and any(
            r.get("kind") == "daily" and r.get("day") == day for r in existing
        ):
            raise LedgerError("duplicate_daily_row", day)
        line = json.dumps(row, sort_keys=True) + "\n"
        descriptor = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            os.write(descriptor, line.encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def ledger_row(
    decision: Decision, kind: str, now: datetime, real_sent: int, seed_sent: int
) -> JsonObject:
    """The row for one decision: stage, volume, each gate's value, and why."""
    return {
        "version": 1,
        "kind": kind,
        "day": decision.day.isoformat(),
        "at": now.isoformat(),
        "action": decision.action.value,
        "stageBefore": decision.stage_before,
        "stageAfter": decision.state.stage,
        "held": decision.state.held,
        "effectiveCap": decision.effective_cap,
        "realSent": real_sent,
        "seedSentNotCounted": seed_sent,
        "reasons": list(decision.reasons),
        "alerts": list(decision.alerts),
        "gates": [
            {
                "name": gate.name,
                "passed": gate.passed,
                "value": gate.value,
                "threshold": gate.threshold,
            }
            for gate in decision.gates
        ],
    }

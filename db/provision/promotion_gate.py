#!/usr/bin/env python3
"""Decide whether a replica may be promoted at a cutover.

Compares the replica's executed source position and thread states against
the source's frozen coordinates. It never reads replication lag. Every
state it does not positively recognise as safe is a refusal.
See promotion_gate.md for the decision table and the live proof.
"""

from __future__ import annotations

import argparse
import math
import re
import subprocess
import sys
import time
from typing import Callable, NamedTuple

from extract_tenant_binlog import BINLOG_SEQUENCE_PATTERN

PROMOTE = "PROMOTE"
WAIT = "WAIT"
ABANDON = "ABANDON"

# The SHOW REPLICA STATUS columns this gate reads, MySQL 8.0.22+ names.
# Seconds_Behind_Source is deliberately absent: a replica receiving
# nothing reports zero lag.
REQUIRED_FIELDS = (
    "Source_UUID",
    "Replica_IO_Running",
    "Replica_SQL_Running",
    "Last_IO_Errno",
    "Last_SQL_Errno",
    "Last_SQL_Error",
    "Relay_Source_Log_File",
    "Exec_Source_Log_Pos",
)

_ROW_HEADER = re.compile(r"^\*+ \d+\. row \*+$")
_FIELD_LINE = re.compile(r"^\s*(?P<key>[A-Za-z_]+):(?: (?P<value>.*))?$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# The smallest position a binary log event can start at, after the magic.
_FIRST_EVENT_POSITION = 4

# The longest the gate may wait. The caller holds the blog's write freeze
# for the whole wait, so the wait must end; ten minutes is far beyond the
# under-a-second catch-up the cutover expects.
MAX_WAIT_SECONDS = 600.0


class GateInputError(Exception):
    """The frozen coordinates or the status text cannot be trusted."""


class StatusReadError(Exception):
    """Reading the replica's status failed."""


class Verdict(NamedTuple):
    decision: str
    reason: str


class Coordinates(NamedTuple):
    base: str
    sequence: int
    position: int


class FrozenSource(NamedTuple):
    server_uuid: str
    log_file: str
    log_position: int


def binlog_coordinates(log_file: str, position: int) -> Coordinates:
    match = BINLOG_SEQUENCE_PATTERN.match(log_file)
    if match is None or "/" in log_file:
        raise GateInputError(f"{log_file!r} is not a binary log file name")
    return Coordinates(match.group("base"), int(match.group("seq")), position)


def validate_frozen(frozen: FrozenSource) -> Coordinates:
    if not _UUID.match(frozen.server_uuid.lower()):
        raise GateInputError(f"source server UUID {frozen.server_uuid!r} is not a UUID")
    if frozen.log_position < _FIRST_EVENT_POSITION:
        raise GateInputError(f"source position {frozen.log_position} is before the first event")
    return binlog_coordinates(frozen.log_file, frozen.log_position)


def parse_replica_status(text: str) -> list[dict[str, str]]:
    """Rows of `SHOW REPLICA STATUS` printed vertically (`\\G`).

    A line that is neither a row header nor a field continues the previous
    field's value, as a multi-line GTID set does. A repeated field, or text
    before the first row header, is refused rather than guessed at.
    """
    rows: list[dict[str, str]] = []
    last_key: str | None = None
    for line in text.splitlines():
        if not line.strip():
            continue
        if _ROW_HEADER.match(line.strip()):
            rows.append({})
            last_key = None
            continue
        if not rows:
            raise GateInputError(f"status text before any row header: {line!r}")
        field = _FIELD_LINE.match(line)
        if field is None:
            if last_key is None:
                raise GateInputError(f"unparsable status line: {line!r}")
            rows[-1][last_key] += "\n" + line.strip()
            continue
        key = field.group("key")
        if key in rows[-1]:
            raise GateInputError(f"field {key} appears twice in one row")
        rows[-1][key] = (field.group("value") or "").strip()
        last_key = key
    return rows


def _as_int(row: dict[str, str], key: str) -> int:
    value = row[key]
    if not value.isdigit():
        raise GateInputError(f"{key} is {value!r}, not a non-negative integer")
    return int(value)


def evaluate(frozen: FrozenSource, rows: list[dict[str, str]]) -> Verdict:
    """One reading of the replica against the frozen source: PROMOTE, WAIT or ABANDON."""
    try:
        target = validate_frozen(frozen)
        return _evaluate_row(frozen, target, rows)
    except GateInputError as error:
        return Verdict(ABANDON, f"unusable input: {error}")


def _evaluate_row(frozen: FrozenSource, target: Coordinates, rows: list[dict[str, str]]) -> Verdict:
    if len(rows) != 1:
        return Verdict(ABANDON, f"expected exactly one replication channel, found {len(rows)}")
    row = rows[0]
    missing = [key for key in REQUIRED_FIELDS if key not in row]
    if missing:
        return Verdict(ABANDON, f"status is missing {', '.join(missing)}")

    if row["Source_UUID"].lower() != frozen.server_uuid.lower():
        return Verdict(
            ABANDON,
            f"coordinates mismatch: replica follows source {row['Source_UUID']!r}, "
            f"frozen coordinates are from {frozen.server_uuid!r}",
        )

    sql_running = row["Replica_SQL_Running"]
    sql_errno = _as_int(row, "Last_SQL_Errno")
    if sql_errno != 0:
        return Verdict(ABANDON, f"SQL thread error {sql_errno}: {row['Last_SQL_Error']}")
    if sql_running != "Yes":
        return Verdict(ABANDON, f"SQL thread is {sql_running!r}, not running")

    io_running = row["Replica_IO_Running"]
    io_errno = _as_int(row, "Last_IO_Errno")
    if io_running not in ("Yes", "Connecting"):
        return Verdict(ABANDON, f"IO thread is {io_running!r}, so the replica cannot catch up")

    executed = binlog_coordinates(row["Relay_Source_Log_File"], _as_int(row, "Exec_Source_Log_Pos"))
    if executed.base != target.base:
        return Verdict(
            ABANDON,
            f"coordinates mismatch: replica executes {row['Relay_Source_Log_File']!r}, "
            f"frozen file is {frozen.log_file!r}",
        )

    where = f"executed {row['Relay_Source_Log_File']}:{executed.position}, frozen {frozen.log_file}:{frozen.log_position}"
    if (executed.sequence, executed.position) > (target.sequence, target.position):
        return Verdict(
            ABANDON,
            f"replica is past the frozen coordinates ({where}): the source wrote after the "
            "freeze, so the coordinates no longer describe the frozen state",
        )
    if (executed.sequence, executed.position) < (target.sequence, target.position):
        return Verdict(WAIT, f"replica is behind ({where}), IO thread {io_running}")
    if io_running != "Yes" or io_errno != 0:
        return Verdict(WAIT, f"positions match but IO thread is {io_running!r} with error {io_errno}")
    return Verdict(PROMOTE, f"positions match ({where}) and both threads report Yes")


def bounded_seconds_problem(seconds: float) -> str | None:
    """Why `seconds` cannot bound a wait, or None; see promotion_gate.md#inputs."""
    if not math.isfinite(seconds):
        return f"{seconds!r} is not a finite number of seconds"
    if seconds <= 0:
        return f"{seconds:g} is not a positive number of seconds"
    if seconds > MAX_WAIT_SECONDS:
        return f"{seconds:g} is more than the {MAX_WAIT_SECONDS:g}-second limit"
    return None


def wait_for_promotion(
    frozen: FrozenSource,
    read_status: Callable[[], list[dict[str, str]]],
    *,
    timeout_seconds: float,
    poll_seconds: float,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Verdict:
    """Polls until PROMOTE or ABANDON; a WAIT still standing at the deadline abandons."""
    for name, seconds in (("timeout", timeout_seconds), ("poll interval", poll_seconds)):
        problem = bounded_seconds_problem(seconds)
        if problem is not None:
            return Verdict(ABANDON, f"{name} is unusable: {problem}")
    deadline = clock() + timeout_seconds
    while True:
        try:
            rows = read_status()
        except (StatusReadError, GateInputError) as error:
            return Verdict(ABANDON, f"replica status could not be read: {error}")
        verdict = evaluate(frozen, rows)
        if verdict.decision != WAIT:
            return verdict
        if clock() >= deadline:
            return Verdict(ABANDON, f"timed out after {timeout_seconds:g}s; last reading: {verdict.reason}")
        sleep(poll_seconds)


def command_status_reader(
    argv: list[str], *, timeout_seconds: float, run=subprocess.run
) -> Callable[[], list[dict[str, str]]]:
    """A reader that runs `argv`, which must print SHOW REPLICA STATUS vertically."""

    def read() -> list[dict[str, str]]:
        try:
            result = run(argv, capture_output=True, text=True, timeout=timeout_seconds, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise StatusReadError(str(error)) from error
        if result.returncode != 0:
            raise StatusReadError(f"exit {result.returncode}: {result.stderr.strip()}")
        return parse_replica_status(result.stdout)

    return read


def _seconds_argument(text: str) -> float:
    try:
        seconds = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a number of seconds") from None
    problem = bounded_seconds_problem(seconds)
    if problem is not None:
        raise argparse.ArgumentTypeError(problem)
    return seconds


class _RefusingParser(argparse.ArgumentParser):
    """A usage error prints a refusal on stdout, where the caller reads the verdict."""

    def error(self, message: str):
        print(f"DO NOT PROMOTE: usage error: {message}")
        self.exit(2)


def _parser() -> argparse.ArgumentParser:
    parser = _RefusingParser(description="Promote a replica only at the frozen coordinates.")
    parser.add_argument("--source-uuid", required=True, help="performance_schema.log_status SERVER_UUID")
    parser.add_argument("--source-log-file", required=True, help="log_status LOCAL binary_log_file")
    parser.add_argument("--source-log-position", required=True, type=int, help="log_status LOCAL binary_log_position")
    parser.add_argument(
        "--timeout", required=True, type=_seconds_argument, help=f"seconds to wait, at most {MAX_WAIT_SECONDS:g}"
    )
    parser.add_argument("--poll", type=_seconds_argument, default=1.0, help="seconds between readings")
    parser.add_argument("status_command", nargs=argparse.REMAINDER, help="-- then a command printing the status")
    return parser


def main(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    command = args.status_command[1:] if args.status_command[:1] == ["--"] else args.status_command
    if not command:
        print("DO NOT PROMOTE: no status command given after --", file=sys.stdout)
        return 2
    frozen = FrozenSource(args.source_uuid, args.source_log_file, args.source_log_position)
    reader = command_status_reader(command, timeout_seconds=max(args.poll, 5.0))
    try:
        verdict = wait_for_promotion(frozen, reader, timeout_seconds=args.timeout, poll_seconds=args.poll)
    except Exception as error:  # noqa: BLE001 -- any surprise is a refusal, never a promotion
        verdict = Verdict(ABANDON, f"gate failed: {error!r}")
    if verdict.decision == PROMOTE:
        print(f"PROMOTE: {verdict.reason}")
        return 0
    print(f"DO NOT PROMOTE: {verdict.reason}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

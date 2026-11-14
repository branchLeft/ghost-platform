#!/usr/bin/env python3
"""Detect the tenant-provisioning gate left open after a run.

`provision-tenant.yml` refuses unless the TENANT_PROVISIONING_FLOW_HETZNERISED
repository variable is exactly "true". The runbook opens it immediately before
a run and closes it afterwards. Nothing else checks that the close happened.
This script is that check. Only the exact string "true" is open, the same
comparison the gate makes; unset, empty and every other value is closed, and
closed is a pass, never an error.

Open is allowed while a provision-tenant run is queued or in progress, and for
a grace period after the latest run last changed, so the operator can close it.
Past that, open is a failure: provisioning is reachable with nobody running it.

Exit 0 passes. Exit 1 reports the gate left open, one ::error:: line. Exit 2
fails closed on a runs file that is missing or malformed while the gate is open.
Rationale and the workflow that calls it: check_provisioning_gate_left_open.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence

OPEN_VALUE = "true"
DEFAULT_GRACE_MINUTES = 120
# Statuses GitHub reports for a run that has not finished.
ACTIVE_STATUSES = frozenset(
    {"queued", "in_progress", "waiting", "requested", "pending"})

EXIT_OK = 0
EXIT_LEFT_OPEN = 1
EXIT_UNUSABLE = 2


class Unusable(Exception):
    """The runs listing cannot be read. Exit 2."""


def parse_time(text: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Unusable("%r is not an ISO 8601 time: %s" % (text, exc))
    if parsed.tzinfo is None:
        raise Unusable("%r carries no time zone" % text)
    return parsed


def load_runs(path: str) -> list[dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        raise Unusable("the runs file is missing at %s" % path)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise Unusable("the runs file cannot be read as JSON: %s" % exc)
    if not isinstance(data, dict) or not isinstance(
            data.get("workflow_runs"), list):
        raise Unusable("the runs file has no workflow_runs list")
    runs = data["workflow_runs"]
    if not all(isinstance(run, dict) for run in runs):
        raise Unusable("a workflow_runs entry is not an object")
    return runs


def evaluate(
    flow_ready: Optional[str],
    runs: Sequence[dict[str, Any]],
    now: datetime,
    grace: timedelta,
) -> tuple[int, str]:
    """Return (exit code, one-line message). Pure: no clock, no network."""
    if flow_ready != OPEN_VALUE:
        return EXIT_OK, "the gate is closed"
    for run in runs:
        if run.get("status") in ACTIVE_STATUSES:
            return EXIT_OK, "the gate is open and a provisioning run is active"
    latest: Optional[datetime] = None
    for run in runs:
        stamp = run.get("updated_at")
        if not isinstance(stamp, str):
            raise Unusable("a run has no updated_at time")
        when = parse_time(stamp)
        if latest is None or when > latest:
            latest = when
    if latest is None:
        return EXIT_LEFT_OPEN, (
            "the gate is open and provision-tenant.yml has no recent run")
    age = now - latest
    if age <= grace:
        return EXIT_OK, (
            "the gate is open, %d minutes after the last run changed; "
            "close it" % (age.total_seconds() // 60))
    return EXIT_LEFT_OPEN, (
        "the gate is open and the last provisioning run changed %d minutes "
        "ago" % (age.total_seconds() // 60))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--flow-ready", default=os.environ.get("FLOW_READY"),
        help="the variable's value; default $FLOW_READY, unset means closed")
    parser.add_argument(
        "--runs-file",
        help="JSON of the workflow's runs (gh api .../runs); needed when open")
    parser.add_argument(
        "--grace-minutes", type=int, default=DEFAULT_GRACE_MINUTES)
    parser.add_argument("--now", help="ISO 8601 time; default the clock")
    args = parser.parse_args(argv)

    try:
        now = parse_time(args.now) if args.now else datetime.now(timezone.utc)
        runs: list[dict[str, Any]] = []
        if args.flow_ready == OPEN_VALUE:
            if not args.runs_file:
                raise Unusable("the gate is open and no --runs-file was given")
            runs = load_runs(args.runs_file)
        code, message = evaluate(
            args.flow_ready, runs, now, timedelta(minutes=args.grace_minutes))
    except Unusable as exc:
        print("::error::cannot decide whether the gate is open: %s" % exc)
        return EXIT_UNUSABLE
    if code == EXIT_OK:
        print(message)
    else:
        print(
            "::error::%s. Close it: gh variable delete "
            "TENANT_PROVISIONING_FLOW_HETZNERISED --repo "
            "branchLeft/ghost-platform" % message)
    return code


if __name__ == "__main__":
    sys.exit(main())

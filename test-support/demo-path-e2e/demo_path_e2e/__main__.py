"""Command line: `run` drives the path once, `prove-sabotage` runs the control case, `summary` prints
the reports a run wrote and `stages` lists the path.

    python3 -m demo_path_e2e run --gate-image demo-gate:ci --report report.json
    python3 -m demo_path_e2e prove-sabotage --gate-image demo-gate:ci --report-dir reports

The result is the exit code and the report, never a log line read by eye: `run`
exits 1 when any stage that ran went red, and with `--require-complete` also
when any stage of the path is not built yet. `prove-sabotage` exits 1 unless
every sabotage turned the run red at its own stage and at no other.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from . import sabotage as sabotages
from .environment import Environment, StartError
from .proof import problems_with
from .report import Report
from .runner import run_stages
from .stages import LIVE_IDS, STAGES

REPO_ROOT = Path(__file__).resolve().parents[3]


def _run_once(gate_image: str, sabotage: sabotages.Sabotage | None) -> Report:
    with Environment(REPO_ROOT, gate_image, sabotage.fault if sabotage else None) as environment:
        return run_stages(STAGES, environment, sabotage.name if sabotage else "")


def _emit(report: Report, path: Path | None) -> None:
    sys.stdout.write(report.to_markdown())
    for result in report.results:
        for line in result.checks:
            sys.stdout.write(f"  ok    {result.stage_id}: {line}\n")
        if result.outcome.value == "failed":
            sys.stdout.write(f"  FAIL  {result.stage_id}: {result.detail}\n")
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(report.to_json() + "\n")


def _command_run(args: argparse.Namespace) -> int:
    sabotage = sabotages.find(args.sabotage) if args.sabotage else None
    report = _run_once(args.gate_image, sabotage)
    _emit(report, args.report)
    if not report.green:
        return 1
    if args.require_complete and not report.complete:
        sys.stdout.write("The path is not complete: a stage is not built yet.\n")
        return 1
    return 0


def _command_prove(args: argparse.Namespace) -> int:
    broken: list[str] = []
    for sabotage in sabotages.SABOTAGES:
        report = _run_once(args.gate_image, sabotage)
        target = args.report_dir / f"{sabotage.stage_id}-{sabotage.fault.value}.json" if args.report_dir else None
        _emit(report, target)
        problems = problems_with(report, sabotage, LIVE_IDS)
        if problems:
            broken.append(sabotage.name)
            for problem in problems:
                sys.stdout.write(f"CONTROL BROKEN {sabotage.name}: {problem}\n")
        else:
            sys.stdout.write(f"CONTROL HELD {sabotage.name}: red at {sabotage.stage_id} and at no other stage\n")
    return 1 if broken else 0


def _command_summary(args: argparse.Namespace) -> int:
    """The reports a run wrote, as the one summary a workflow run shows: read from the files, never from the log."""
    for path in args.reports:
        sys.stdout.write(Report.from_json(path.read_text()).to_markdown() + "\n")
    return 0


def _command_stages(_: argparse.Namespace) -> int:
    for stage in STAGES:
        state = "built" if stage.run is not None else f"not built: {stage.missing}"
        sys.stdout.write(f"{stage.stage_id}: {stage.title} ({state})\n")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="demo_path_e2e", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="drive the path once")
    run.add_argument("--gate-image", required=True, help="the demo-gate image under test")
    run.add_argument("--report", type=Path, help="where to write the JSON report")
    run.add_argument("--sabotage", default="", help="run under one sabotage, e.g. gated-read:wrong-hash")
    run.add_argument("--require-complete", action="store_true", help="also fail while any stage is not built")
    run.set_defaults(handler=_command_run)

    prove = commands.add_parser("prove-sabotage", help="break each built stage in turn; each must go red alone")
    prove.add_argument("--gate-image", required=True)
    prove.add_argument("--report-dir", type=Path)
    prove.set_defaults(handler=_command_prove)

    summary = commands.add_parser("summary", help="print the summary of the reports a run wrote")
    summary.add_argument("reports", nargs="+", type=Path)
    summary.set_defaults(handler=_command_summary)

    listing = commands.add_parser("stages", help="list the path and what is built")
    listing.set_defaults(handler=_command_stages)

    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except StartError as error:
        sys.stderr.write(f"the environment did not start: {error}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())

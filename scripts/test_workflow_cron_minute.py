"""No scheduled workflow fires at minute 0 of an hour.

Run: python3 -m unittest discover -s scripts -p 'test_workflow_cron_minute.py'
What it checks, and why: test_workflow_cron_minute.md.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import List, Set

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

CRON_LINE = re.compile(r"^\s*-\s*cron:\s*(?P<q>['\"]?)(?P<expr>.+?)(?P=q)\s*$")


def crons(text: str) -> List[str]:
    """Every `- cron: '...'` expression in the text, comment lines skipped."""
    found: List[str] = []
    for line in text.splitlines():
        if re.match(r"^\s*#", line):
            continue
        match = CRON_LINE.match(line.split(" #")[0])
        if match:
            found.append(match.group("expr").strip())
    return found


def minutes(field: str) -> Set[int]:
    """The minutes (0-59) a cron minute field fires on.

    A form this reader does not know raises, so it fails the test instead of
    being waved through.
    """
    fired: Set[int] = set()
    for part in field.split(","):
        step = 1
        if "/" in part:
            part, raw_step = part.split("/", 1)
            if not raw_step.isdigit() or int(raw_step) < 1:
                raise AssertionError(f"unreadable minute step in `{field}`")
            step = int(raw_step)
        if part == "*":
            low, high = 0, 59
        elif re.fullmatch(r"\d+-\d+", part):
            low, high = (int(n) for n in part.split("-"))
        elif part.isdigit():
            low = int(part)
            high = 59 if step > 1 else low
        else:
            raise AssertionError(f"unreadable minute field `{field}`")
        if not 0 <= low <= high <= 59:
            raise AssertionError(f"minute out of range in `{field}`")
        fired.update(range(low, high + 1, step))
    return fired


def top_of_the_hour(expr: str) -> bool:
    fields = expr.split()
    if len(fields) != 5:
        raise AssertionError(f"a cron expression has five fields: `{expr}`")
    return 0 in minutes(fields[0])


def violations() -> List[str]:
    found: List[str] = []
    for path in sorted(WORKFLOWS.iterdir()):
        if path.suffix not in (".yml", ".yaml"):
            continue
        for expr in crons(path.read_text(encoding="utf-8")):
            if top_of_the_hour(expr):
                found.append(f"{path.name}: {expr}")
    return found


class WorkflowCronMinute(unittest.TestCase):
    def test_no_schedule_fires_at_minute_zero(self) -> None:
        self.assertEqual(
            violations(),
            [],
            "GitHub drops scheduled runs at the top of the hour under load, and "
            "major-watcher-run.yml's `0 */6 * * *` never ran once: pick an "
            "off-the-hour minute (for example `43 */6 * * *`)",
        )

    def test_reader_finds_the_schedules(self) -> None:
        total = sum(len(crons(p.read_text(encoding="utf-8"))) for p in WORKFLOWS.glob("*.yml"))
        self.assertGreater(total, 15)

    def test_reader_flags_a_zero_minute(self) -> None:
        self.assertTrue(top_of_the_hour("0 */6 * * *"))

    def test_reader_flags_a_zero_minute_in_a_list(self) -> None:
        self.assertTrue(top_of_the_hour("0,30 * * * *"))

    def test_reader_flags_a_wildcard_minute(self) -> None:
        self.assertTrue(top_of_the_hour("* * * * *"))

    def test_reader_flags_a_stepped_minute(self) -> None:
        self.assertTrue(top_of_the_hour("*/15 * * * *"))

    def test_reader_flags_a_range_from_zero(self) -> None:
        self.assertTrue(top_of_the_hour("0-10 * * * *"))

    def test_reader_accepts_an_off_the_hour_minute(self) -> None:
        self.assertFalse(top_of_the_hour("43 */6 * * *"))

    def test_reader_accepts_a_stepped_start_off_the_hour(self) -> None:
        self.assertFalse(top_of_the_hour("7-59/20 * * * *"))

    def test_reader_refuses_an_unreadable_field(self) -> None:
        with self.assertRaises(AssertionError):
            top_of_the_hour("H * * * *")

    def test_reader_skips_comments_and_reads_quoted_and_bare(self) -> None:
        text = "on:\n  schedule:\n    # - cron: '0 0 * * *'\n    - cron: '5 4 * * 1'\n    - cron: 6 4 * * 1\n"
        self.assertEqual(crons(text), ["5 4 * * 1", "6 4 * * 1"])

    def test_reader_ignores_a_trailing_comment(self) -> None:
        self.assertEqual(crons("    - cron: '5 4 * * 1' # weekly\n"), ["5 4 * * 1"])


if __name__ == "__main__":
    unittest.main()

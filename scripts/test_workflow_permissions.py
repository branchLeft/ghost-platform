"""Every job in every workflow runs under an explicit `permissions` grant.

Run: python3 -m unittest discover -s scripts -p 'test_workflow_permissions.py'
What it checks, and why: test_workflow_permissions.md.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"


def strip_comments(text: str) -> List[str]:
    return [line for line in text.splitlines() if line.strip() and not re.match(r"^\s*#", line)]


def has_top_level_permissions(lines: List[str]) -> bool:
    return any(re.match(r"^permissions:", line) for line in lines)


def job_blocks(lines: List[str]) -> Dict[str, List[str]]:
    """The lines under each job of the top-level `jobs:` mapping.

    A workflow this reader cannot parse raises, so it fails the test instead
    of being skipped.
    """
    try:
        start = next(i for i, line in enumerate(lines) if re.match(r"^jobs:\s*$", line))
    except StopIteration:
        raise AssertionError("no top-level `jobs:` mapping") from None
    blocks: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for line in lines[start + 1 :]:
        if not line.startswith(" "):
            break
        key = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if key:
            current = key.group(1)
            blocks[current] = []
        elif re.match(r"^  \S", line):
            raise AssertionError(f"unexpected line under `jobs:`: {line.strip()}")
        elif current is not None:
            blocks[current].append(line)
    if not blocks:
        raise AssertionError("the `jobs:` mapping names no job")
    return blocks


def jobs_without_permissions(text: str) -> List[str]:
    """The jobs that would run under the repository's default token grant.

    A workflow-level `permissions` key covers every job. Without one, each job
    needs its own; a job that has none gets the repository default, which may
    be write to contents, packages and actions.
    """
    lines = strip_comments(text)
    if has_top_level_permissions(lines):
        return []
    return sorted(
        name
        for name, block in job_blocks(lines).items()
        if not any(re.match(r"^    permissions:", line) for line in block)
    )


def violations() -> List[str]:
    found: List[str] = []
    for path in sorted(WORKFLOWS.iterdir()):
        if path.suffix not in (".yml", ".yaml"):
            continue
        for job in jobs_without_permissions(path.read_text(encoding="utf-8")):
            found.append(f"{path.name}:{job}")
    return found


TOP_LEVEL = """\
name: x
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: true
"""

NONE = TOP_LEVEL.replace("permissions:\n  contents: read\n", "")

PER_JOB = """\
name: x
on:
  pull_request:
jobs:
  a:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: true
  b:
    permissions: {}
    uses: o/r/.github/workflows/w.yml@v1
"""


class WorkflowPermissions(unittest.TestCase):
    def test_every_job_has_an_explicit_grant(self) -> None:
        self.assertEqual(
            violations(),
            [],
            "these jobs run under the repository's default token grant: add a "
            "workflow-level `permissions:` (contents: read unless a job needs more), "
            "and widen only the job that needs it, at job level, with the reason beside it",
        )

    def test_reader_examines_workflows(self) -> None:
        self.assertGreater(len(list(WORKFLOWS.glob("*.yml"))), 20)

    def test_reader_accepts_a_top_level_grant(self) -> None:
        self.assertEqual(jobs_without_permissions(TOP_LEVEL), [])

    def test_reader_accepts_an_empty_top_level_grant(self) -> None:
        self.assertEqual(jobs_without_permissions(TOP_LEVEL.replace("permissions:\n  contents: read", "permissions: {}")), [])

    def test_reader_flags_a_workflow_with_no_grant(self) -> None:
        self.assertEqual(jobs_without_permissions(NONE), ["a"])

    def test_reader_accepts_a_grant_on_every_job(self) -> None:
        self.assertEqual(jobs_without_permissions(PER_JOB), [])

    def test_reader_flags_the_one_job_without_a_grant(self) -> None:
        text = PER_JOB.replace("    permissions: {}\n", "")
        self.assertEqual(jobs_without_permissions(text), ["b"])

    def test_reader_ignores_a_commented_grant(self) -> None:
        self.assertEqual(jobs_without_permissions(TOP_LEVEL.replace("permissions:", "# permissions:")), ["a"])

    def test_reader_ignores_a_step_level_key_named_permissions(self) -> None:
        text = NONE.replace("      - run: true", "      - with:\n          permissions: write")
        self.assertEqual(jobs_without_permissions(text), ["a"])

    def test_reader_refuses_a_workflow_with_no_jobs(self) -> None:
        with self.assertRaises(AssertionError):
            jobs_without_permissions("name: x\non:\n  pull_request:\n")


if __name__ == "__main__":
    unittest.main()

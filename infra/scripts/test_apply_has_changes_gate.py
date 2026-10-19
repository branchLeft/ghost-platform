#!/usr/bin/env python3
"""Structure pins: each gated apply job in the two infra workflows skips on an
explicit `has_changes` of 'false', and each plan job publishes that output.

Text-level checks on the workflow files, stdlib only. The verdict itself is
tested in test_plan_has_changes.py."""

from __future__ import annotations

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
WORKFLOWS = {
    "infra-demo-host-ci.yml": ("plan", "apply"),
    "infra-hosts-ci.yml": ("plan", "apply"),
}
MAIN_OPERANDS = [
    "github.event_name == 'push'",
    "github.ref == 'refs/heads/main'",
]
PUBLISH = "has_changes: ${{ steps.noop.outputs.has_changes }}"
DECIDE_STEP = "python3 ../scripts/plan-has-changes.py preview.json preview-plan.json"


def _job_block(text: str, job: str) -> str:
    """The text of one top-level job, from its key to the next job key or the end."""
    match = re.search(rf"^  {re.escape(job)}:\n", text, re.MULTILINE)
    if not match:
        return ""
    rest = text[match.end():]
    nxt = re.search(r"^  [A-Za-z0-9_-]+:\n", rest, re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def _if_value(block: str) -> str:
    """The `if:` of a job, folded or single-line, as one string."""
    match = re.search(r"^    if: (>-\n((?:      .*\n?)+)|(.*))", block, re.MULTILINE)
    if not match:
        return ""
    if match.group(2) is not None:
        return " ".join(line.strip() for line in match.group(2).splitlines())
    return match.group(3).strip()


class ApplyGateStructure(unittest.TestCase):
    def read(self, name: str) -> str:
        return (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")

    def test_every_gated_apply_job_skips_only_on_an_explicit_false(self):
        for name, (plan, apply) in WORKFLOWS.items():
            with self.subTest(workflow=name):
                block = _job_block(self.read(name), apply)
                self.assertTrue(block, f"{name}: no {apply} job")
                cond = _if_value(block)
                self.assertIn(f"needs.{plan}.outputs.has_changes != 'false'", cond,
                              f"{name}: the {apply} job's if: lacks the has_changes operand")
                for operand in MAIN_OPERANDS:
                    self.assertIn(operand, cond, f"{name}: the {apply} job's if: lost {operand}")
                self.assertNotIn("||", cond, f"{name}: the {apply} job's if: has an OR")

    def test_every_plan_job_publishes_has_changes_from_the_decision_step(self):
        for name, (plan, _) in WORKFLOWS.items():
            with self.subTest(workflow=name):
                text = self.read(name)
                block = _job_block(text, plan)
                self.assertIn(PUBLISH, block, f"{name}: the {plan} job does not publish has_changes")
                self.assertIn("id: noop", block, f"{name}: the {plan} job has no noop step")
                self.assertIn(DECIDE_STEP, block, f"{name}: the {plan} job does not run the decision")

    def test_the_decision_step_precedes_the_summary_write(self):
        for name, (plan, _) in WORKFLOWS.items():
            with self.subTest(workflow=name):
                block = _job_block(self.read(name), plan)
                self.assertLess(block.index("id: noop"), block.index("Write the plan to the job summary"),
                                f"{name}: the decision must write the summary's first line")


if __name__ == "__main__":
    unittest.main()

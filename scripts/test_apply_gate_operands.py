"""Every check-apply-gate call in this repo's CI names the operands its apply jobs carry.

Run: python3 -m unittest discover -s scripts -p 'test_apply_gate_operands.py'
The shared action checks `required-operands` only when a caller passes it, so
a call without it passes while the apply `if:` stays unpinned. Each call that
gates an infra workflow of this repo must pass both operands.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Dict, List

ROOT = Path(__file__).resolve().parent.parent
CI = ROOT / ".github" / "workflows" / "repo-tooling-ci.yml"
ACTION = "branchLeft/github-workflows/.github/actions/check-apply-gate@"
REQUIRED = ("github.event_name == 'push'", "github.ref == 'refs/heads/main'")
GATED = (".github/workflows/infra-hosts-ci.yml", ".github/workflows/infra-demo-host-ci.yml")


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def call_blocks(lines: List[str]) -> List[List[str]]:
    """The lines of each step that calls the check-apply-gate action.

    A step runs from its `uses:` line until a non-blank line indented less
    than that `uses:` line, which is the next step or the end of the job.
    """
    blocks: List[List[str]] = []
    for i, line in enumerate(lines):
        if ACTION not in line:
            continue
        base = indent_of(line)
        block = [line]
        for following in lines[i + 1 :]:
            if following.strip() and indent_of(following) < base:
                break
            block.append(following)
        blocks.append(block)
    return blocks


def operands_of(block: List[str]) -> List[str]:
    """The lines under `required-operands:`, folded and stripped."""
    for i, line in enumerate(block):
        if not re.match(r"^required-operands:\s*[|>]?\s*$", line.strip()):
            continue
        key = indent_of(line)
        operands: List[str] = []
        for following in block[i + 1 :]:
            if following.strip() and indent_of(following) <= key:
                break
            if following.strip():
                operands.append(following.strip())
        return operands
    return []


def workflow_of(block: List[str]) -> str:
    for line in block:
        match = re.match(r"^\s*workflow:\s*(\S+)\s*$", line)
        if match:
            return match.group(1)
    return ""


class ApplyGateOperands(unittest.TestCase):
    def setUp(self) -> None:
        self.calls: Dict[str, List[str]] = {}
        lines = CI.read_text(encoding="utf-8").splitlines()
        for block in call_blocks(lines):
            self.calls[workflow_of(block)] = block

    def test_each_gated_workflow_has_a_call(self) -> None:
        for workflow in GATED:
            self.assertIn(workflow, self.calls, f"no check-apply-gate call names {workflow}")

    def test_each_call_names_both_operands(self) -> None:
        for workflow in GATED:
            with self.subTest(workflow=workflow):
                operands = operands_of(self.calls.get(workflow, []))
                for required in REQUIRED:
                    self.assertIn(
                        required,
                        operands,
                        f"the check-apply-gate call for {workflow} lacks `{required}` "
                        "in required-operands",
                    )


if __name__ == "__main__":
    unittest.main()

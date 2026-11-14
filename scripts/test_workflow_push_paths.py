"""A workflow that filters pull requests by path must filter its push to main too.

Run: python3 -m unittest discover -s scripts -p 'test_workflow_push_paths.py'
What it checks, and how an exception is added: test_workflow_push_paths.md.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

# Workflows whose push to main is deliberately unfiltered although their pull
# request run is filtered. Each needs a reason that names the thing relying on
# the unfiltered push. A stale entry (no longer a violation) fails the test.
EXCEPTIONS: Dict[str, str] = {
    "infra-provisioning-scripts-ci.yml": (
        "its pull request filter cannot list every file a secret-bearing job "
        "imports from elsewhere, and test_codeowners_ownership.py relies on "
        "the unfiltered push to main to catch one that CODEOWNERS does not own"
    ),
}


def strip_comments(text: str) -> List[str]:
    return [line for line in text.splitlines() if not re.match(r"^\s*#", line)]


def event_blocks(text: str) -> Dict[str, List[str]]:
    """The lines under each trigger of the top-level `on:` mapping.

    A push or pull_request written inline raises, so a workflow this reader
    cannot parse fails the test instead of being skipped.
    """
    lines = strip_comments(text)
    try:
        start = next(i for i, line in enumerate(lines) if re.match(r"^on:\s*$", line))
    except StopIteration:
        raise AssertionError("no top-level `on:` mapping") from None
    blocks: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for line in lines[start + 1 :]:
        if line.strip() and not line.startswith(" "):
            break
        key = re.match(r"^  ([A-Za-z_]+):(.*)$", line)
        if key:
            inline = key.group(2).strip()
            if inline and (key.group(1) in ("push", "pull_request") or inline not in ("{}", "[]")):
                raise AssertionError(f"trigger {key.group(1)} is written inline: {line.strip()}")
            current = key.group(1)
            blocks[current] = []
        elif line.strip():
            if current is None:
                raise AssertionError(f"unexpected line under `on:`: {line.strip()}")
            blocks[current].append(line)
    if not blocks:
        raise AssertionError("the `on:` mapping names no trigger")
    return blocks


def has_key(block: List[str], key: str) -> bool:
    return any(re.match(rf"^    {key}:", line) for line in block)


def push_to_main_is_unfiltered(text: str) -> bool:
    """True if the workflow filters pull requests by path and its push to main does not."""
    blocks = event_blocks(text)
    pull_request = blocks.get("pull_request")
    push = blocks.get("push")
    if pull_request is None or push is None:
        return False
    if not has_key(pull_request, "paths"):
        return False
    if has_key(push, "tags") and not has_key(push, "branches"):
        return False  # a tag-only push is not a push to main
    return not has_key(push, "paths") and not has_key(push, "paths-ignore")


def violations() -> List[str]:
    return sorted(
        p.name
        for p in WORKFLOWS.iterdir()
        if p.suffix in (".yml", ".yaml") and push_to_main_is_unfiltered(p.read_text(encoding="utf-8"))
    )


PR_ONLY = """\
name: x
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    paths:
      - 'a/**'
"""

PUSH_TAIL = "    branches: [main]\n  pull_request"
MIRRORED = PR_ONLY.replace(PUSH_TAIL, "    branches: [main]\n    paths:\n      - 'a/**'\n  pull_request")


class WorkflowPushPaths(unittest.TestCase):
    def test_every_filtered_pull_request_workflow_filters_its_push(self) -> None:
        unlisted = [name for name in violations() if name not in EXCEPTIONS]
        self.assertEqual(
            unlisted,
            [],
            "these workflows have `pull_request.paths` but a path-less `push` on main: "
            "mirror the paths onto the push, or list the workflow in EXCEPTIONS with a reason",
        )

    def test_exceptions_are_still_violations(self) -> None:
        current = set(violations())
        stale = sorted(name for name in EXCEPTIONS if name not in current)
        self.assertEqual(stale, [], "remove these from EXCEPTIONS: they no longer need it")

    def test_exceptions_carry_a_reason(self) -> None:
        for name, reason in EXCEPTIONS.items():
            self.assertGreater(len(reason.split()), 5, name)

    def test_reader_examines_workflows(self) -> None:
        self.assertGreater(len(list(WORKFLOWS.glob("*.yml"))), 20)

    def test_reader_flags_a_path_less_push(self) -> None:
        self.assertTrue(push_to_main_is_unfiltered(PR_ONLY))

    def test_reader_accepts_a_mirrored_push(self) -> None:
        self.assertFalse(push_to_main_is_unfiltered(MIRRORED))

    def test_reader_accepts_paths_ignore_on_push(self) -> None:
        text = PR_ONLY.replace(PUSH_TAIL, "    branches: [main]\n    paths-ignore: ['b/**']\n  pull_request")
        self.assertFalse(push_to_main_is_unfiltered(text))

    def test_reader_ignores_a_commented_paths_key(self) -> None:
        text = PR_ONLY.replace(PUSH_TAIL, "    branches: [main]\n    # paths:\n  pull_request")
        self.assertTrue(push_to_main_is_unfiltered(text))

    def test_reader_ignores_an_unfiltered_pull_request(self) -> None:
        text = "on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n"
        self.assertFalse(push_to_main_is_unfiltered(text))

    def test_reader_ignores_a_tag_only_push(self) -> None:
        text = PR_ONLY.replace(PUSH_TAIL, "    tags: ['v*']\n  pull_request")
        self.assertFalse(push_to_main_is_unfiltered(text))

    def test_reader_refuses_an_inline_trigger(self) -> None:
        with self.assertRaises(AssertionError):
            push_to_main_is_unfiltered("on:\n  push: {branches: [main]}\n  pull_request: {paths: [a]}\n")


if __name__ == "__main__":
    unittest.main()

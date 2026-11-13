#!/usr/bin/env python3
"""The native snapshot proof must run when the Percona pin moves.

The Percona digest the proof pulls lives in .github/image-mirror/images.json,
and the helper that reads it is db/provision/percona_pin.py. The proof workflow
is path-filtered, so a re-pin that touches neither file would be merged without
the proof ever running on it. The three proofs also load db/provision/gtid_snapshot.py
through extract_tenant_binlog.py, and the job's Python comes from .python-version.
This test fails when the push or pull_request filter of snapshot-proof-ci.yml
leaves any of these out. The pattern for the helper is a glob, so it stays valid
whether the helper is present yet or not.
"""

from __future__ import annotations

import pathlib
import re
import unittest

_REPO = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = _REPO / ".github" / "workflows" / "snapshot-proof-ci.yml"

REQUIRED = (
    ".github/image-mirror/images.json",
    "db/provision/percona_pin*",
    "db/provision/gtid_snapshot.py",
    ".python-version",
)
TRIGGERS = ("push", "pull_request")


def trigger_paths(workflow_text: str, trigger: str) -> list[str]:
    """The quoted entries of the `paths:` list under one `on:` trigger."""
    lines = workflow_text.splitlines()
    try:
        on_at = lines.index("on:")
    except ValueError:
        return []
    paths: list[str] = []
    in_trigger = False
    in_paths = False
    for line in lines[on_at + 1 :]:
        if line and not line.startswith(" "):
            break
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if indent == 2 and stripped.endswith(":"):
            in_trigger = stripped == f"{trigger}:"
            in_paths = False
        elif in_trigger and indent == 4 and stripped.endswith(":"):
            in_paths = stripped == "paths:"
        elif in_trigger and in_paths and stripped.startswith("- "):
            paths.append(stripped[2:].strip().strip("'\""))
    return paths


def unwatched(workflow_text: str) -> list[str]:
    """Each (trigger, path) pair the workflow's filters leave out."""
    return [
        f"{trigger}: {required}"
        for trigger in TRIGGERS
        for required in REQUIRED
        if required not in trigger_paths(workflow_text, trigger)
    ]


class SnapshotProofPathsTest(unittest.TestCase):
    def test_the_proof_watches_the_pin_on_push_and_pull_request(self) -> None:
        self.assertEqual(unwatched(WORKFLOW.read_text(encoding="utf-8")), [])

    def test_the_parser_reads_the_real_filters(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        for trigger in TRIGGERS:
            with self.subTest(trigger=trigger):
                self.assertIn(
                    ".github/workflows/snapshot-proof-ci.yml", trigger_paths(text, trigger)
                )

    def test_a_filter_without_the_mirror_list_is_flagged(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        sabotaged = re.sub(r"^ +- '\.github/image-mirror/images\.json'\n", "", text, flags=re.M)
        self.assertNotEqual(sabotaged, text)
        self.assertEqual(
            unwatched(sabotaged),
            [f"{t}: .github/image-mirror/images.json" for t in TRIGGERS],
        )

    def test_dropping_the_gtid_helper_or_the_python_version_is_flagged(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        for dropped in ("db/provision/gtid_snapshot.py", ".python-version"):
            with self.subTest(dropped=dropped):
                sabotaged = re.sub(
                    rf"^ +- '{re.escape(dropped)}'\n", "", text, flags=re.M
                )
                self.assertNotEqual(sabotaged, text)
                self.assertEqual(unwatched(sabotaged), [f"{t}: {dropped}" for t in TRIGGERS])

    def test_a_filter_complete_on_one_trigger_only_is_flagged(self) -> None:
        entries = "".join(f"      - '{required}'\n" for required in REQUIRED)
        text = (
            f"on:\n  push:\n    paths:\n{entries}"
            "  pull_request:\n    paths:\n      - 'db/other'\n"
            "permissions:\n  contents: read\n"
        )
        self.assertEqual(unwatched(text), [f"pull_request: {r}" for r in REQUIRED])


if __name__ == "__main__":
    unittest.main()

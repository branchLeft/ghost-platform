"""Unit tests for assert_live_boot_ran.py: the gate that decides the boot job."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

import assert_live_boot_ran as gate

TITLE = gate.LIVE_TEST_TITLE


def report(*assertions: tuple[str, str]) -> dict[str, Any]:
    """A vitest JSON report with one file holding the given (title, status) assertions."""
    return {
        "testResults": [
            {
                "name": "test/tenant-live-boot.test.ts",
                "assertionResults": [
                    {"title": title, "status": status, "fullName": f"LIVE tenant boot: {title}"}
                    for title, status in assertions
                ],
            }
        ]
    }


class CheckTest(unittest.TestCase):
    def test_passed_is_accepted(self) -> None:
        self.assertIsNone(gate.check(report((TITLE, "passed"), ("needs TENANT_BOOT_IMAGE", "skipped"))))

    def test_skipped_is_refused(self) -> None:
        reason = gate.check(report((TITLE, "skipped")))
        self.assertIsNotNone(reason)
        self.assertIn("'skipped'", reason or "")

    def test_failed_is_refused(self) -> None:
        reason = gate.check(report((TITLE, "failed")))
        self.assertIsNotNone(reason)
        self.assertIn("'failed'", reason or "")

    def test_missing_is_refused(self) -> None:
        reason = gate.check(report(("needs TENANT_BOOT_IMAGE", "passed")))
        self.assertIn("missing", reason or "")

    def test_empty_report_is_refused(self) -> None:
        self.assertIn("missing", gate.check({"testResults": []}) or "")

    def test_duplicated_is_refused(self) -> None:
        reason = gate.check(report((TITLE, "passed"), (TITLE, "passed")))
        self.assertIn("2 times", reason or "")

    def test_wrong_title_is_refused(self) -> None:
        # The old bash gate's shape: the marker with the name right after it,
        # not the name as vitest reports it. A wrong title must not pass.
        reason = gate.check(report(("✓ " + TITLE, "passed")))
        self.assertIn("missing", reason or "")


class MainTest(unittest.TestCase):
    def run_main(self, payload: dict[str, Any]) -> int:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vitest-boot.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return gate.main(["assert_live_boot_ran.py", str(path)])

    def test_passed_exits_zero(self) -> None:
        self.assertEqual(self.run_main(report((TITLE, "passed"))), 0)

    def test_skipped_exits_one(self) -> None:
        self.assertEqual(self.run_main(report((TITLE, "skipped"))), 1)

    def test_missing_exits_one(self) -> None:
        self.assertEqual(self.run_main({"testResults": []}), 1)

    def test_bad_usage_exits_two(self) -> None:
        self.assertEqual(gate.main(["assert_live_boot_ran.py"]), 2)


if __name__ == "__main__":
    unittest.main()

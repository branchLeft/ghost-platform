"""Fail unless the live tenant boot test ran and passed.

Reads the JSON report vitest writes (`--reporter=json --outputFile.json=...`)
and checks the live boot test's own status. A skipped or missing test fails:
without the image and Docker the boot job must not pass as green.

Usage: assert_live_boot_ran.py <vitest-json-report>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# The exact title of the live test in render-core/test/tenant-live-boot.test.ts.
LIVE_TEST_TITLE = "starts the throwaway database, then the rendered Ghost, and gets 200 on /"


def live_test_statuses(report: dict[str, Any]) -> list[str]:
    """Every status reported for an assertion titled as the live test."""
    statuses: list[str] = []
    for file_result in report.get("testResults", []):
        for assertion in file_result.get("assertionResults", []):
            if assertion.get("title") == LIVE_TEST_TITLE:
                statuses.append(str(assertion.get("status")))
    return statuses


def check(report: dict[str, Any]) -> str | None:
    """Return None when the live test passed exactly once, else the reason it did not."""
    statuses = live_test_statuses(report)
    if not statuses:
        return "the live tenant boot test is missing from the report"
    if len(statuses) != 1:
        return f"the live tenant boot test appears {len(statuses)} times, expected once"
    if statuses[0] != "passed":
        return f"the live tenant boot test is '{statuses[0]}', not 'passed'"
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: assert_live_boot_ran.py <vitest-json-report>", file=sys.stderr)
        return 2
    report = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    reason = check(report)
    if reason is not None:
        print(f"::error::{reason}", file=sys.stderr)
        return 1
    print("live tenant boot test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

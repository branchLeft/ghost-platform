#!/usr/bin/env python3
"""What `db/stack/conf.d/branchleft.cnf` must keep true, and nothing else checks.

See test_branchleft_cnf_contract.md#module-overview.
"""

from __future__ import annotations

import pathlib
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
CNF = REPO_ROOT / "db" / "stack" / "conf.d" / "branchleft.cnf"


def cnf_lines() -> list[str]:
    """Non-blank, non-comment lines, in file order."""
    return [
        line.strip()
        for line in CNF.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


class BinlogFormatIsPinned(unittest.TestCase):
    def test_binlog_format_row_is_pinned(self) -> None:
        self.assertIn("binlog_format = ROW", cnf_lines())

    def test_binlog_format_is_pinned_exactly_once(self) -> None:
        # A second, later `binlog_format` line would win under MySQL's own
        # last-one-wins config parsing while this file still reads as pinned.
        matches = [line for line in cnf_lines() if line.startswith("binlog_format")]
        self.assertEqual(matches, ["binlog_format = ROW"])


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""What `db/stack/conf.d/branchleft.cnf` must keep true, and nothing else checks.

Per-tenant point-in-time recovery (doc 14 §7.2) replays a tenant's writes out
of the shared binlog by filtering row events on the table's database name.
STATEMENT format carries no such per-row marker -- a statement event replays
against whatever database the replaying session's most recent `USE` left
active, which loses writes issued outside that `USE` and can replay a
statement against the wrong tenant's database entirely.

ROW happens to be MySQL 8.0's compiled-in default, so undoing this pin would
not change today's behaviour and mysqld itself would not flag the regression
-- only a future default change, or an operator override, would, and by then
a restore is already broken. This test is what would have failed instead.

Line-based rather than an INI parse, matching this directory's other
compose/cnf contract tests: the property asserted here is a single-line fact.
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

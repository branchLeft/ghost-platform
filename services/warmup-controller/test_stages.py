"""The stage table matches the collector's, and the controller can neither send nor reach a spool."""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

from warmup_controller.stages import STAGES, UnknownStageError, caps_for

HERE = Path(__file__).resolve().parent
COLLECTOR_TABLE = HERE.parent / "mail-collector" / "src" / "ip2Lane.ts"
FORBIDDEN_IMPORTS = frozenset(
    {"smtplib", "socket", "ssl", "subprocess", "email", "imaplib", "poplib"}
)
ROW = re.compile(
    r"\{\s*stage:\s*(\d+),\s*total:\s*(\d+),\s*gmail:\s*(\d+),\s*microsoft:\s*(\d+),\s*yahoo:\s*(\d+)\s*\}"
)


class StageTableTests(unittest.TestCase):
    def test_table_matches_the_collectors(self) -> None:
        rows = [
            tuple(int(n) for n in m.groups()) for m in ROW.finditer(COLLECTOR_TABLE.read_text())
        ]
        ours = [(s.stage, s.total, s.gmail, s.microsoft, s.yahoo) for s in STAGES]
        self.assertEqual(len(rows), 7)
        self.assertEqual(ours, rows)

    def test_seven_stages_from_50_to_3200(self) -> None:
        self.assertEqual([s.total for s in STAGES], [50, 100, 200, 400, 800, 1600, 3200])

    def test_unknown_stage_is_refused(self) -> None:
        for stage in (0, 8, -1):
            with self.subTest(stage=stage), self.assertRaises(UnknownStageError):
                caps_for(stage)


class NoSendingTests(unittest.TestCase):
    def test_no_module_imports_a_way_to_send_or_reach_a_spool(self) -> None:
        for source in sorted((HERE / "warmup_controller").glob("*.py")):
            for node in ast.walk(ast.parse(source.read_text())):
                names: list[str] = []
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif (
                    isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0
                ):
                    names = [node.module]
                for name in names:
                    with self.subTest(module=source.name, imported=name):
                        self.assertNotIn(name.split(".")[0], FORBIDDEN_IMPORTS)


if __name__ == "__main__":
    unittest.main()

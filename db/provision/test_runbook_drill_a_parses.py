#!/usr/bin/env python3
"""Every fenced shell command in db/RUNBOOK-db.md's Drill A must parse.

The runbook-literal-placeholders test reads placeholders, not shell, so a
quote that swallows the rest of a pipeline passed it. Each fenced bash block
from the start of Drill A to the start of Drill B (steps 4 and 5 included) is
checked with `bash -n`, and with `zsh -n` where zsh is installed, because the
runbook is run from a Mac's zsh as well as from bash.
"""

import pathlib
import re
import shutil
import subprocess
import textwrap
import unittest

RUNBOOK = pathlib.Path(__file__).resolve().parent.parent / "RUNBOOK-db.md"
START = "### Drill A"
END = "### Drill B"
FENCE_OPEN = re.compile(r"^(?P<indent>[ ]*)```(?:bash|sh)\s*$")
FENCE_CLOSE = re.compile(r"^[ ]*```\s*$")


def drill_a_shell_blocks(text: str) -> list[tuple[int, str]]:
    """(line number of the opening fence, dedented body) for each fenced
    shell block between the Drill A and Drill B headings."""
    lines = text.splitlines()
    begin = next(i for i, line in enumerate(lines) if line.startswith(START))
    end = next(i for i, line in enumerate(lines) if line.startswith(END))
    blocks: list[tuple[int, str]] = []
    i = begin
    while i < end:
        opened = FENCE_OPEN.match(lines[i])
        if opened is None:
            i += 1
            continue
        j = i + 1
        while not FENCE_CLOSE.match(lines[j]):
            j += 1
        blocks.append((i + 1, textwrap.dedent("\n".join(lines[i + 1 : j])) + "\n"))
        i = j + 1
    return blocks


class DrillAShellParsesTests(unittest.TestCase):
    def test_the_section_has_the_blocks_this_test_is_about(self):
        blocks = drill_a_shell_blocks(RUNBOOK.read_text(encoding="utf-8"))
        joined = "\n".join(body for _, body in blocks)
        self.assertIn("--all-databases", joined)
        self.assertIn("SHOW DATABASES", joined)
        self.assertGreaterEqual(len(blocks), 6)

    def _check(self, shell: str) -> None:
        if shutil.which(shell) is None:
            self.skipTest(f"{shell} is not installed here")
        for line, body in drill_a_shell_blocks(RUNBOOK.read_text(encoding="utf-8")):
            with self.subTest(shell=shell, fence_line=line):
                result = subprocess.run([shell, "-n"], input=body, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, f"{shell} -n rejected the fence at line {line}:\n{result.stderr}")

    def test_every_block_parses_under_bash(self):
        self._check("bash")

    def test_every_block_parses_under_zsh(self):
        self._check("zsh")

    def test_the_parser_sees_the_failure_it_exists_for(self):
        # Control: the lone backtick inside double quotes that slipped through.
        broken = 'grep -oE "^CREATE (DATABASE|SCHEMA) (IF NOT EXISTS )?`?[A-Za-z0-9_$]+" | sort -u\n'
        result = subprocess.run(["bash", "-n"], input=broken, capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()

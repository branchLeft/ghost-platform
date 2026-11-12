#!/usr/bin/env python3
"""Sabotage proof for branchleft_slot: disable the mount-point refusal in a
scratch copy and require the suite red, then the untouched copy green.

Usage: sabotage_branchleft_slot.py

Prints `RED` when the sabotaged copy fails the suite (the refusal is proven),
`NOT RED` and exit 1 when it still passes, then `GREEN` for the untouched copy.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent

# (name, old text, new text) -- each edits branchleft_slot.py only.
SABOTAGES = [
    ("drop the mount-point device check (the walk crosses a mount)",
     "if os.fstat(child_fd).st_dev != dev:",
     "if False:"),
    ("drop the not-loaded tolerance on a reset stop (a missing unit aborts the reset)",
     "        if ops.unit_is_stopped(unit):\n            return\n",
     "        if False:\n            return\n"),
]


def run_suite(directory: pathlib.Path) -> bool:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_branchleft_slot"],
        cwd=directory, capture_output=True, text=True,
    )
    return result.returncode == 0


def main() -> int:
    failures = 0
    for name, old, new in SABOTAGES:
        with tempfile.TemporaryDirectory() as tmp:
            scratch = pathlib.Path(tmp) / "provision"
            shutil.copytree(HERE, scratch, ignore=shutil.ignore_patterns("__pycache__"))
            target = scratch / "branchleft_slot.py"
            source = target.read_text(encoding="utf-8")
            if source.count(old) != 1:
                print(f"BROKEN SABOTAGE (pattern found {source.count(old)} times): {name}")
                failures += 1
                continue
            target.write_text(source.replace(old, new), encoding="utf-8")
            red = not run_suite(scratch)
        print(f"{'RED' if red else 'NOT RED'}: {name}")
        failures += 0 if red else 1
    green = run_suite(HERE)
    print(f"{'GREEN' if green else 'NOT GREEN'}: unsabotaged suite")
    return 0 if failures == 0 and green else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Sabotage proof for the recycle's host-side residue check: loosen each wipe the
reset does (the data volume, the content volume, the slot directory, the env
files) in a scratch copy and require test_recycle_residue red, then the untouched
copy green.

Usage: sabotage_recycle_residue.py

Prints `RED` and the newly failing tests when the sabotaged copy fails the suite
(the residue assertion saw what was left behind), `NOT RED` and exit 1 when it
does not, then `GREEN` for the untouched copy.
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
    ("the data volume is not emptied (a file stays in it)",
     '        ops.remove_volume_contents(str(_data_directory(invocation.slot)))\n',
     '        pass\n'),
    ("the content volume is not emptied (its files stay)",
     '        if content_volume is not None:\n            ops.remove_volume_contents(str(_content_directory(content_volume)))\n',
     '        pass\n'),
    ("the slot directory is not emptied",
     '        ops.remove_dir_contents(slot_dir)\n',
     '        pass\n'),
    ("the colours' environment files are not removed (a stale env file stays)",
     '            ops.remove_file_if_present(\n                os.path.join(ETC_DIR, f"demo-{invocation.slot}-{colour}.env")\n            )\n',
     '            pass\n'),
    ("only the first colour's environment file is removed",
     '        for colour in COLOURS:\n            ops.remove_file_if_present(',
     '        for colour in COLOURS[:1]:\n            ops.remove_file_if_present('),
    ("the slot directory's wipe leaves its sub-directories behind",
     '            else:\n                shutil.rmtree(target)\n',
     '            else:\n                pass\n'),
]

SUITE = "test_recycle_residue"


def run_suite(directory: pathlib.Path) -> tuple[bool, list[str]]:
    """(passed, the failing test names)."""
    result = subprocess.run(
        [sys.executable, "-m", "unittest", SUITE],
        cwd=directory, capture_output=True, text=True,
    )
    failing = [
        line.split(": ", 1)[1].split(" (")[0]
        for line in result.stderr.splitlines()
        if line.startswith(("FAIL: ", "ERROR: "))
    ]
    return result.returncode == 0, failing


def scratch_copy(tmp: str) -> pathlib.Path:
    scratch = pathlib.Path(tmp) / "provision"
    shutil.copytree(HERE, scratch, ignore=shutil.ignore_patterns("__pycache__"))
    return scratch


def main() -> int:
    failures = 0
    for name, old, new in SABOTAGES:
        with tempfile.TemporaryDirectory() as tmp:
            scratch = scratch_copy(tmp)
            target = scratch / "branchleft_slot.py"
            source = target.read_text(encoding="utf-8")
            if source.count(old) != 1:
                print(f"BROKEN SABOTAGE (pattern found {source.count(old)} times): {name}")
                failures += 1
                continue
            target.write_text(source.replace(old, new), encoding="utf-8")
            passed, failing = run_suite(scratch)
        print(f"{'NOT RED' if passed else 'RED'}: {name}")
        for test in failing:
            print(f"    red test: {test}")
        failures += 1 if passed else 0
    green, _ = run_suite(HERE)
    print(f"{'GREEN' if green else 'NOT GREEN'}: unsabotaged suite")
    return 0 if failures == 0 and green else 1


if __name__ == "__main__":
    raise SystemExit(main())

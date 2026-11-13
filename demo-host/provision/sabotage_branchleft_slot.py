#!/usr/bin/env python3
"""Sabotage proof for branchleft_slot: loosen one control at a time (the mount-point
refusal, the reset's stopped-unit ruling, the volumes `start` creates) in a scratch copy and require the suite red, then the untouched copy green.

Usage: sabotage_branchleft_slot.py

Prints `RED` and the newly failing tests when the sabotaged copy fails the suite
beyond what an untouched scratch copy already fails (the control is proven),
`NOT RED` and exit 1 when it does not, then `GREEN` for the untouched copy.
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
    ('drop the not-loaded tolerance on a reset stop (a missing unit aborts the reset)',
     '        if ops.unit_is_stopped(unit):\n            return\n',
     '        if False:\n            return\n'),
    ('tolerate every stop failure (the state is no longer consulted)',
     '        if ops.unit_is_stopped(unit):\n            return\n',
     '        if True:\n            return\n'),
    ('tolerate ActiveState=failed as stopped',
     '            or properties.get("ActiveState") == "inactive"\n',
     '            or properties.get("ActiveState") in ("inactive", "failed")\n'),
    ('tolerate ActiveState=activating as stopped',
     '            or properties.get("ActiveState") == "inactive"\n',
     '            or properties.get("ActiveState") in ("inactive", "activating")\n'),
    ('tolerate ActiveState=deactivating as stopped',
     '            or properties.get("ActiveState") == "inactive"\n',
     '            or properties.get("ActiveState") in ("inactive", "deactivating")\n'),
    ('tolerate ActiveState=active as stopped',
     '            or properties.get("ActiveState") == "inactive"\n',
     '            or properties.get("ActiveState") in ("inactive", "active")\n'),
    ('drop the inactive branch (only a not-found unit counts as stopped)',
     '            or properties.get("ActiveState") == "inactive"\n',
     '            or False\n'),
    ('drop the not-found branch (only an inactive unit counts as stopped)',
     '            properties.get("LoadState") == "not-found"\n',
     '            False\n'),
    ('a missing ActiveState is taken as inactive',
     'properties.get("ActiveState") == "inactive"',
     'properties.get("ActiveState", "inactive") == "inactive"'),
    ('a missing LoadState is taken as not-found',
     'properties.get("LoadState") == "not-found"',
     'properties.get("LoadState", "not-found") == "not-found"'),
    ('systemctl show failing is no longer an error (check=True dropped)',
     '            check=True,\n            capture_output=True,\n',
     '            capture_output=True,\n'),
    ('a stop error that is not a failed exit is swallowed too',
     '    except subprocess.CalledProcessError:\n        if ops.unit_is_stopped',
     '    except Exception:\n        if ops.unit_is_stopped'),
    ('start no longer creates the slot volumes',
     '                ops.ensure_slot_volumes(SLOT_DIR.format(slot=invocation.slot), invocation.slot)\n',
     '                pass\n'),
    ('stop and read verbs create the slot volumes too',
     '            if invocation.verb == "start":\n',
     '            if True:\n'),
    ("another slot's data volume is named for creation",
     '        if line.rstrip() in data_keys:\n            data.add(data_key)\n',
     '        if re.fullmatch(r"  \'?ghost-demo-[0-9]+-data\'?:", line.rstrip()):\n'
     '            data.add(line.strip().strip("\':"))\n'),
    ('two content or adapters volumes are no longer refused',
     '        if len(found) > 1:\n',
     '        if False:\n'),
    ('a failed docker volume create is no longer an error (check=True dropped)',
     '                ["docker", "volume", "create", name],\n                check=True,\n',
     '                ["docker", "volume", "create", name],\n'),
    ('docker volume create has no timeout',
     '                timeout=_VOLUME_CREATE_TIMEOUT_SECONDS,\n',
     ''),
]


def run_suite(directory: pathlib.Path) -> tuple[bool, list[str]]:
    """(passed, the `FAIL:`/`ERROR:` lines of the run, one per failing test)."""
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_branchleft_slot"],
        cwd=directory, capture_output=True, text=True,
    )
    failing = [
        line.split(": ", 1)[1].split(" (")[0] + (" (" + line.split(" (", 1)[1] if " (" in line else "")
        for line in result.stderr.splitlines()
        if line.startswith(("FAIL: ", "ERROR: "))
    ]
    return result.returncode == 0, failing


def scratch_copy(tmp: str) -> pathlib.Path:
    scratch = pathlib.Path(tmp) / "provision"
    shutil.copytree(HERE, scratch, ignore=shutil.ignore_patterns("__pycache__"))
    return scratch


def main() -> int:
    # A scratch copy sits outside the repo, so a few tests that read files by a
    # relative path fail there with nothing sabotaged. A row is red only when it
    # fails tests beyond that baseline; otherwise every row would be red for free.
    with tempfile.TemporaryDirectory() as tmp:
        _, baseline = run_suite(scratch_copy(tmp))
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
            _, failing = run_suite(scratch)
        newly_red = [test for test in failing if test not in baseline]
        red = bool(newly_red)
        print(f"{'RED' if red else 'NOT RED'}: {name}")
        for test in newly_red:
            print(f"    red test: {test}")
        failures += 0 if red else 1
    green, _ = run_suite(HERE)
    print(f"{'GREEN' if green else 'NOT GREEN'}: unsabotaged suite")
    return 0 if failures == 0 and green else 1


if __name__ == "__main__":
    raise SystemExit(main())

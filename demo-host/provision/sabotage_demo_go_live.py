#!/usr/bin/env python3
"""Sabotage proof for demo_go_live: break each refusal in a scratch copy and
require the suite red, then the untouched copy green.

Usage: sabotage_demo_go_live.py
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent

# (name, old text, new text) -- each edits demo_go_live.py only.
SABOTAGES = [
    ("drop the stand-in refusal (a stand-in-loaded broker opens)",
     '            if names:\n                raise GoLiveRefused(f"slot {slot}: {why}: {\', \'.join(sorted(names))}")\n',
     ""),
    ("ignore interim modules",
     '(("notReal", "test stand-in loaded"), ("interim", "interim module loaded"))',
     '(("notReal", "test stand-in loaded"),)'),
    ("treat a missing list as clean",
     "if not isinstance(names, list) or not all(isinstance(n, str) for n in names):",
     "if False:"),
    ("treat an unreachable broker as clean",
     '            raise GoLiveRefused(f"slot {slot}: broker status unreadable ({type(error).__name__})") from error',
     "            continue"),
    ("skip the clock check",
     "if not (clock or clock_is_synchronised)():",
     "if False:"),
    ("clock reader always says synchronised",
     '    return result.returncode == 0 and result.stdout.strip() == "yes"',
     "    return True"),
    ("clock reader ignores a non-zero exit",
     '    return result.returncode == 0 and result.stdout.strip() == "yes"',
     '    return result.stdout.strip() == "yes"'),
    ("missing timedatectl counts as synchronised",
     "    except (OSError, subprocess.TimeoutExpired):\n        return False\n",
     "    except (OSError, subprocess.TimeoutExpired):\n        return True\n"),
    ("broker reader blanks the stand-in lists",
     "        return json.loads(response.read())\n",
     "        body = json.loads(response.read())\n        body.update(notReal=[], interim=[])\n        return body\n"),
    ("broker reader asks the wrong slot",
     'url = f"{broker_url.rstrip(\'/\')}/status/{slot}"',
     'url = f"{broker_url.rstrip(\'/\')}/status/0"'),
    ("check only slot 0",
     "    for slot in slots:\n        try:",
     "    for slot in slots[:1]:\n        try:"),
    ("install before the check",
     "    check_seams(broker_url, fetch=fetch or fetch_status)\n",
     "    write_generated_file(install_path, open(caddyfile_src, encoding='utf-8').read())\n    check_seams(broker_url, fetch=fetch or fetch_status)\n"),
]


def run_suite(directory: pathlib.Path) -> bool:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_demo_go_live"],
        cwd=directory, capture_output=True, text=True,
    )
    return result.returncode == 0


def main() -> int:
    failures = 0
    for name, old, new in SABOTAGES:
        with tempfile.TemporaryDirectory() as tmp:
            scratch = pathlib.Path(tmp) / "provision"
            shutil.copytree(HERE, scratch, ignore=shutil.ignore_patterns("__pycache__"))
            target = scratch / "demo_go_live.py"
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

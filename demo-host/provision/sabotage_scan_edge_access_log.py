#!/usr/bin/env python3
"""Sabotage proof for scan_edge_access_log: break each check in a scratch copy
and require the suite red, then the untouched copy green.

Usage: sabotage_scan_edge_access_log.py
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent

# (name, old text, new text) -- each edits scan_edge_access_log.py only.
SABOTAGES = [
    ("never look at the query parameter names",
     "    if names & PASSPHRASE_PARAMETER_NAMES:\n",
     "    if False:\n"),
    ("compare parameter names case-sensitively",
     "{name.lower() for name, _ in",
     "{name for name, _ in"),
    ("never search for a known passphrase",
     "    if any(phrase in haystack for phrase in known):\n",
     "    if False:\n"),
    ("match a known passphrase only as typed, not re-encoded",
     "    haystack = normalise(url)\n",
     "    haystack = url\n"),
    ("ignore the referer header",
     "        urls = [request[\"uri\"], *_referers(request)]\n",
     "        urls = [request[\"uri\"]]\n"),
    ("read an empty log as clean",
     "    if entries == 0:\n",
     "    if False:\n"),
    ("skip a line that is not an entry instead of refusing it",
     "        if not isinstance(request, dict) or not isinstance(request.get(\"uri\"), str):\n            raise UnreadableLog(f\"line {number} is not an access log entry\")\n",
     "        if not isinstance(request, dict) or not isinstance(request.get(\"uri\"), str):\n            continue\n"),
    ("skip a line that is not JSON instead of refusing it",
     "        except ValueError as error:\n            raise UnreadableLog(f\"line {number} is not JSON\") from error\n",
     "        except ValueError:\n            continue\n"),
    ("accept a known passphrase too short to search for",
     "        if len(phrase) < MIN_KNOWN_LENGTH:\n",
     "        if False:\n"),
    ("print the finding with its URL",
     "            print(f\"RED: line {number}: {reason}\")\n",
     "            print(f\"RED: line {number}: {reason}: {open(args.log).read()}\")\n"),
]


def run_suite(directory: pathlib.Path) -> bool:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_scan_edge_access_log"],
        cwd=directory, capture_output=True, text=True,
    )
    return result.returncode == 0


def main() -> int:
    failures = 0
    for name, old, new in SABOTAGES:
        with tempfile.TemporaryDirectory() as tmp:
            scratch = pathlib.Path(tmp)
            for module in ("scan_edge_access_log.py", "test_scan_edge_access_log.py"):
                shutil.copy(HERE / module, scratch / module)
            target = scratch / "scan_edge_access_log.py"
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

#!/usr/bin/env python3
"""Refuse a private tracker reference in tracked public source.

Public source must not name a private tracker issue, in either spelling:
the short form (the tracker's name, a hash and a number) or the full issue
URL on github.com. The owner's ruling and the reason it is a gate are
recorded in the private tracker.

Usage:
  assert-no-private-tracker-refs.py [--self-test] [PATH ...]

With PATH arguments, scan those files (pre-commit passes the staged ones).
With none, scan every git-tracked file in the working directory.
Exit 0 when clean, 1 when a reference is found, 2 on usage error.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
from dataclasses import dataclass

# The tracker's short spelling, `<name>#<number>`, and the full issue URL.
# Both need a digit run; the bare name or the repo name alone is not a reference.
SHORT_FORM = re.compile(r"workspace#\d+")
FULL_FORM = re.compile(r"github\.com/branchLeft/workspace/issues/\d+")
PATTERNS: tuple[re.Pattern[str], ...] = (SHORT_FORM, FULL_FORM)


@dataclass(frozen=True)
class Finding:
    path: pathlib.Path
    line: int
    text: str


def find_refs(text: str) -> list[tuple[int, str]]:
    """Return (line number, matched text) for each reference, in reading order."""
    found: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for pattern in PATTERNS:
            for match in pattern.finditer(line):
                found.append((number, match.group(0)))
    found.sort(key=lambda item: item[0])
    return found


def _is_binary(data: bytes) -> bool:
    return b"\x00" in data


def scan_paths(paths: list[pathlib.Path]) -> list[Finding]:
    """Scan text files; binary and unreadable paths are skipped, not reported."""
    findings: list[Finding] = []
    for path in paths:
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if _is_binary(data):
            continue
        text = data.decode("utf-8", errors="replace")
        for line, matched in find_refs(text):
            findings.append(Finding(path=path, line=line, text=matched))
    return findings


def _tracked_files() -> list[pathlib.Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        check=True,
        capture_output=True,
    ).stdout
    return [pathlib.Path(name) for name in out.decode("utf-8").split("\0") if name]


def self_test() -> int:
    """Hermetic checks of the matcher in both directions; no files are read."""
    cases: list[tuple[str, int]] = [
        ("work" + "space" + "#1302", 1),
        ("https://github.com/branchLeft/" + "workspace" + "/issues/3203", 1),
        ("branchLeft/" + "workspace" + " by design", 0),
        ("work" + "space" + "#abc", 0),
        ("https://github.com/branchLeft/ghost-platform/issues/12", 0),
    ]
    failures = [
        text for text, expected in cases if len(find_refs(text)) != expected
    ]
    if failures:
        for text in failures:
            print(f"self-test FAILED: {text!r}", file=sys.stderr)
        return 1
    print("self-test ok")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    if any(arg.startswith("-") for arg in argv):
        print(__doc__, file=sys.stderr)
        return 2
    paths = [pathlib.Path(arg) for arg in argv] if argv else _tracked_files()
    findings = scan_paths(paths)
    for finding in findings:
        print(
            f"{finding.path}:{finding.line}: private tracker reference "
            f"{finding.text!r}; reword it in plain words",
            file=sys.stderr,
        )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

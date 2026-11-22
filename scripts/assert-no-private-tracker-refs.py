#!/usr/bin/env python3
"""Refuse a private tracker reference in tracked public source.

Public source must not name a private tracker issue, in either spelling:
the short form (the tracker's name, a hash and a number) or an issue, pull or
API URL on github.com. Matching is case-insensitive. The owner's ruling and
the reason it is a gate are recorded in the private tracker.

Usage:
  assert-no-private-tracker-refs.py [--self-test] [PATH ...]

With PATH arguments, scan those files (pre-commit passes the staged ones).
With none, scan every git-tracked file in the working directory.
Exit 0 when clean, 1 when a reference is found or a file cannot be read,
2 on usage error. A file the gate cannot read is a failure, not a skip.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
from dataclasses import dataclass

# The tracker's short spelling, `<name>#<number>`, and the URL forms: an issue,
# a pull, or the API route of either. Both need a digit run; the bare name or
# the repo name alone is not a reference.
SHORT_FORM = re.compile(r"workspace#\d+", re.IGNORECASE)
URL_FORM = re.compile(
    r"(?:api\.)?github\.com/(?:repos/)?branchLeft/workspace/(?:issues|pulls?)/\d+",
    re.IGNORECASE,
)
PATTERNS: tuple[re.Pattern[str], ...] = (SHORT_FORM, URL_FORM)

# Paths the gate may skip without reading them. Empty: every file is read.
# Adding a path is a reviewed change to this file, never a runtime choice.
BINARY_ALLOWLIST: frozenset[str] = frozenset()

# Byte order marks, longest first, so UTF-32 LE is not read as UTF-16 LE.
_BOMS: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xfe\x00\x00", "utf-32-le"),
    (b"\x00\x00\xfe\xff", "utf-32-be"),
    (b"\xef\xbb\xbf", "utf-8"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)


@dataclass(frozen=True)
class Finding:
    path: pathlib.Path
    line: int  # 0 when the file could not be read at all
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


def texts_of(data: bytes) -> list[str]:
    """Every reading of the bytes that could hide a reference.

    A byte order mark picks the codec. Without one the bytes are read as
    latin-1, which decodes every byte, and again with NUL bytes removed so a
    BOM-less UTF-16 file of ASCII text is read too. Nothing is dropped.
    """
    for bom, codec in _BOMS:
        if data.startswith(bom):
            return [data[len(bom) :].decode(codec, errors="replace")]
    raw = data.decode("latin-1")
    return [raw, raw.replace("\x00", "")]


def scan_paths(paths: list[pathlib.Path]) -> list[Finding]:
    """Scan every path. Only an allowlisted path is skipped; an unreadable one is a finding."""
    findings: list[Finding] = []
    for path in paths:
        if str(path) in BINARY_ALLOWLIST:
            continue
        try:
            data = path.read_bytes()
        except OSError:
            findings.append(Finding(path=path, line=0, text=""))
            continue
        seen: set[tuple[int, str]] = set()
        for text in texts_of(data):
            for line, matched in find_refs(text):
                if (line, matched) not in seen:
                    seen.add((line, matched))
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
        ("WORK" + "SPACE" + "#5", 1),
        ("https://github.com/branchLeft/" + "workspace" + "/issues/3203", 1),
        ("https://github.com/branchleft/" + "workspace" + "/pull/7", 1),
        ("https://api.github.com/repos/branchLeft/" + "workspace" + "/issues/9", 1),
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
        if finding.line == 0:
            print(
                f"{finding.path}: could not read this file; the gate cannot clear it",
                file=sys.stderr,
            )
            continue
        print(
            f"{finding.path}:{finding.line}: private tracker reference "
            f"{finding.text!r}; reword it in plain words",
            file=sys.stderr,
        )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

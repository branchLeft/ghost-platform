#!/usr/bin/env python3
"""Decide whether a CI job may skip its heavy steps for one diff.

Reads the output of ``git diff --no-renames --name-status -z BASE...HEAD`` on
stdin and prints ``skip`` or ``run``. A job skips only when every changed path
is a file its heavy steps never read, as named by the gate's allow-list.

Fails closed: an empty diff, any status other than added or modified (so a
deletion, a rename's old side, or a type change), a path that does not match
the allow-list, a path with a non-ASCII byte, a record that does not parse, and
bytes that are not UTF-8 all print ``run``. An unknown gate name exits 2.

Usage: ci_skip_decision.py {image,docs-lint} < changes.z
"""

from __future__ import annotations

import re
import sys
from typing import Final

# Paths the image job never reads: the image is built from the Dockerfile and
# what it copies, and the image tests read the scripts, packages and trees
# named in the workflow. Docs, the README, the licence and other workflow files
# are not among them. build.yml itself is excluded, so a change to it runs.
IMAGE_GATE: Final[tuple[str, ...]] = (
    r"docs/.+\.(md|png|txt)",
    r"README\.md",
    r"LICENSE",
    r"\.github/workflows/(?!build\.yml$)[^/]+\.ya?ml",
)

# Paths the docs-lint reusable workflow never reads. It reads markdown, HTML,
# the code extensions it scans for comments, and the .docs-lint* files; any
# other extension, and any file it does not classify, is outside its input.
# JSON is deliberately not listed: markdownlint reads .markdownlint.json (and
# nested copies), and a rule switched off there changes the verdict.
DOCS_LINT_GATE: Final[tuple[str, ...]] = (
    r"(.+/)?[^/]+\.(png|jpe?g|gif|svg|txt)",
    r"(.+/)?LICENSE",
)

GATES: Final[dict[str, tuple[str, ...]]] = {
    "image": IMAGE_GATE,
    "docs-lint": DOCS_LINT_GATE,
}

SKIPPABLE_STATUSES: Final[frozenset[str]] = frozenset({"A", "M"})

Record = tuple[str, str]


def parse(data: bytes) -> list[Record] | None:
    """Split NUL-separated ``STATUS PATH`` records; None when they do not parse."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    fields = text.split("\0")
    if fields and fields[-1] == "":
        fields.pop()
    if len(fields) % 2 != 0:
        return None
    return [(fields[i], fields[i + 1]) for i in range(0, len(fields), 2)]


def decide(records: list[Record] | None, gate: tuple[str, ...]) -> str:
    """``skip`` only when every record is an added or modified ASCII path the gate allows."""
    if not records:
        return "run"
    patterns = [re.compile(pattern) for pattern in gate]
    for status, path in records:
        if status not in SKIPPABLE_STATUSES:
            return "run"
        if not path or not path.isascii():
            return "run"
        if not any(pattern.fullmatch(path) for pattern in patterns):
            return "run"
    return "skip"


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in GATES:
        sys.stderr.write("usage: ci_skip_decision.py {image,docs-lint} < changes.z\n")
        return 2
    records = parse(sys.stdin.buffer.read())
    print(decide(records, GATES[argv[1]]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

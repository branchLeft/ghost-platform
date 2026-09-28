#!/usr/bin/env python3
"""Validate a `package_dir` value before it is trusted by a CI job.

Usage:
    assert-lockfile-package-dir.py <package_dir>
    assert-lockfile-package-dir.py --self-test

`generate-lockfile.yml` takes `package_dir` as free-text `workflow_dispatch`
input and later uses it to build a filesystem path and a `git add` argument
in a job that holds `contents: write`. This is the one gate between that
free text and the filesystem: it accepts only `services/<name>` or
`adapters/<name>`, where `<name>` is lowercase alphanumeric groups joined
by single hyphens -- no leading, trailing or doubled hyphen, no path
separator inside `<name>` and no way to spell `..`. A value this rejects
never reaches `npm install`, `git add` or a shell string.

This checks *shape* only -- that the value cannot address anything outside
the two directories npm packages live in here. Whether the directory exists
and holds a `package.json` is checked separately, once the target branch is
actually on disk (see `generate-lockfile.yml`), because that answer depends
on which branch is checked out and this script does not take one.

Exit 0 if `package_dir` has the required shape, 1 if not, 2 on usage error.
"""

from __future__ import annotations

import re
import sys

# Anchored both ends. `[a-z0-9-]+` alone would admit a trailing slash, an
# empty second segment, or a second `/` -- any of which would either point
# outside `services/` and `adapters/` or make the later `git add` argument
# ambiguous about which path it names. The name itself is alphanumeric
# groups joined by single hyphens (`[a-z0-9]+(-[a-z0-9]+)*`), not the looser
# `[a-z0-9-]+` this used to be: that admitted a leading or doubled hyphen,
# which a value starting with `-` can turn into an option flag for whatever
# reads it next.
PACKAGE_DIR_PATTERN = re.compile(r"\A(services|adapters)/[a-z0-9]+(-[a-z0-9]+)*\Z")


def is_allowed_package_dir(value: str) -> bool:
    return bool(PACKAGE_DIR_PATTERN.match(value))


# (value, expected). Each rejection case documents the specific thing it
# closes, because a pattern that merely "looks strict" can still admit one
# of these by accident.
CASES: list[tuple[str, bool]] = [
    ("services/ring-controller", True),
    ("adapters/sso", True),
    ("adapters/scanning-storage", True),
    ("services/a", True),
    ("", False),  # empty input
    ("main", False),  # no top-level segment at all
    ("services", False),  # top segment with nothing under it
    ("services/", False),  # trailing slash, empty name
    ("services//sso", False),  # doubled separator
    ("services/ring-controller/", False),  # trailing slash after a real name
    ("services/ring-controller/extra", False),  # a third path segment
    ("services/../secrets", False),  # traversal out of services/
    ("services/..", False),  # traversal, no third segment
    ("packages/ring-controller", False),  # not an allowed top segment
    ("Services/ring-controller", False),  # wrong case on the top segment
    ("services/Ring-Controller", False),  # uppercase in the name
    ("services/ring_controller", False),  # underscore, not hyphen
    ("services/ring controller", False),  # space
    ("services/ring-controller\n", False),  # trailing newline (a common
    # side effect of reading an input from a file or a shell substitution
    # that didn't strip it)
    ("/services/ring-controller", False),  # leading slash
    ("services/ring-controller; rm -rf /", False),  # shell metacharacters
    ("services/-rf", False),  # leading hyphen -- could read as an option flag
    ("services/--x", False),  # doubled leading hyphen, same reason
    ("services/ring-", False),  # trailing hyphen
    ("services/ring--controller", False),  # doubled interior hyphen
]


def self_test() -> int:
    failed = False
    for value, expected in CASES:
        actual = is_allowed_package_dir(value)
        ok = actual is expected
        failed |= not ok
        verb = "accepts" if actual else "rejects"
        want = "accept" if expected else "reject"
        print(f"{'PASS' if ok else 'FAIL'}: {value!r} -> {verb} (expected {want})")

    if failed:
        print(
            "\nThis gate no longer matches the shape it is meant to enforce. "
            "Treat every failing case above as a value that would reach the "
            "filesystem or the shell unchecked."
        )
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) != 2:
        print(__doc__)
        return 2

    package_dir = argv[1]
    if is_allowed_package_dir(package_dir):
        print(f"OK: {package_dir!r} matches services/<name> or adapters/<name>")
        return 0

    print(
        f"::error::package_dir {package_dir!r} does not match "
        "^services/[a-z0-9-]+$ or ^adapters/[a-z0-9-]+$"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

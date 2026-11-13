#!/usr/bin/env python3
"""Check that every pnpm workspace consuming a @branchleft package excludes it from minimumReleaseAge.

Usage:
    assert-release-age-exclude.py [<repo_root>]
    assert-release-age-exclude.py --self-test

For each pnpm-workspace.yaml whose directory holds a package.json depending on
a @branchleft/* package, the file must contain the exact top-level line
`minimumReleaseAgeExclude: ['@branchleft/*']` and must not set minimumReleaseAge.
Exit 0 if all pass, 1 if one fails, 2 on usage error.
"""

from __future__ import annotations

import json
import os
import sys

REQUIRED_LINE = "minimumReleaseAgeExclude: ['@branchleft/*']"
FORBIDDEN_PREFIX = "minimumReleaseAge:"
DEPENDENCY_KEYS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
SKIP_DIRS = {"node_modules", ".git"}


def consumes_branchleft(package_json_text: str) -> bool:
    manifest = json.loads(package_json_text)
    for key in DEPENDENCY_KEYS:
        for name in manifest.get(key) or {}:
            if name.startswith("@branchleft/"):
                return True
    return False


def workspace_problem(workspace_text: str) -> str | None:
    lines = workspace_text.splitlines()
    if REQUIRED_LINE not in lines:
        return f"missing the top-level line {REQUIRED_LINE!r}"
    if any(line.startswith(FORBIDDEN_PREFIX) for line in lines):
        return "sets minimumReleaseAge, which must keep the default for third-party packages"
    return None


# (workspace_text, package_json_text, should_pass)
CASES: list[tuple[str, str, bool]] = [
    (
        f"{REQUIRED_LINE}\n",
        '{"devDependencies": {"@branchleft/tsconfig": "^0.4.0"}}',
        True,
    ),
    (
        "allowBuilds:\n  esbuild: false\n",
        '{"dependencies": {"@branchleft/x": "1.0.0"}}',
        False,
    ),
    ("", '{"dependencies": {"@branchleft/x": "1.0.0"}}', False),
    (
        "minimumReleaseAgeExclude: ['@branchleft/*', 'lodash']\n",
        '{"dependencies": {"@branchleft/x": "1.0.0"}}',
        False,
    ),
    (f"# {REQUIRED_LINE}\n", '{"dependencies": {"@branchleft/x": "1.0.0"}}', False),
    (f"  {REQUIRED_LINE}\n", '{"dependencies": {"@branchleft/x": "1.0.0"}}', False),
    (
        f"{REQUIRED_LINE}\nminimumReleaseAge: 1440\n",
        '{"dependencies": {"@branchleft/x": "1.0.0"}}',
        False,
    ),
    ("", '{"dependencies": {"left-pad": "1.3.0"}}', True),
]


def self_test() -> int:
    failed = False
    for workspace_text, package_json_text, should_pass in CASES:
        if consumes_branchleft(package_json_text):
            actual_pass = workspace_problem(workspace_text) is None
        else:
            actual_pass = True
        ok = actual_pass is should_pass
        failed |= not ok
        print(
            f"{'PASS' if ok else 'FAIL'}: expected {'pass' if should_pass else 'fail'}, got {'pass' if actual_pass else 'fail'}"
        )
    if failed:
        print(
            "\nThis gate no longer tells a consuming workspace without the exclusion from a compliant one."
        )
    return 1 if failed else 0


def scan(root: str) -> int:
    checked = 0
    failures = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if "pnpm-workspace.yaml" not in filenames or "package.json" not in filenames:
            continue
        with open(os.path.join(dirpath, "package.json"), encoding="utf-8") as handle:
            if not consumes_branchleft(handle.read()):
                continue
        checked += 1
        rel = os.path.relpath(os.path.join(dirpath, "pnpm-workspace.yaml"), root)
        with open(
            os.path.join(dirpath, "pnpm-workspace.yaml"), encoding="utf-8"
        ) as handle:
            problem = workspace_problem(handle.read())
        if problem is None:
            print(f"OK: {rel}")
        else:
            failures += 1
            print(
                f"::error file={rel}::{rel} consumes a @branchleft package and {problem}"
            )
    print(f"checked {checked} consuming workspace(s), {failures} failing")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) > 2:
        print(__doc__)
        return 2
    root = argv[1] if len(argv) == 2 else "."
    return scan(root)


if __name__ == "__main__":
    sys.exit(main(sys.argv))

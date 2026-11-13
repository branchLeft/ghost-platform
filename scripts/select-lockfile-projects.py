#!/usr/bin/env python3
"""Pick the pnpm projects a pull request's changed files put in question.

Usage:
    git diff -z --name-only BASE...HEAD | select-lockfile-projects.py [--root DIR]

Reads NUL-separated changed paths on stdin and prints one line of JSON, a
list of {"dir", "slug"} objects, for every changed `package.json` that
belongs to a pnpm project consuming a `@branchleft/*` package from the
registry (a `link:` dependency does not count: it needs no registry read).
Nothing is executed and nothing is interpolated: package.json is parsed as
data, and a directory whose name falls outside the allow-list shape is
skipped. See scripts/select-lockfile-projects.md.

Exit 0 on success, 1 when more projects than MAX_PROJECTS are selected, so a
huge change fails visibly instead of silently truncating.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

MAX_PROJECTS = 20
SCOPE = "@branchleft/"
DEPENDENCY_FIELDS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
# Anchored both ends: the value ends up in a matrix and, from there, in an
# `env:` and an action input, never in a shell line, but a name outside this
# shape is still refused rather than trusted.
DIR_SHAPE = re.compile(r"\A(\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)\Z")


def project_dir(changed: str) -> str | None:
    """The project directory a changed path names, or None if it is not a package.json."""
    if changed == "package.json":
        return "."
    if changed.endswith("/package.json"):
        return changed[: -len("/package.json")]
    return None


def consumes_registry_scope(manifest: dict[str, object]) -> bool:
    for field in DEPENDENCY_FIELDS:
        deps = manifest.get(field)
        if not isinstance(deps, dict):
            continue
        for name, spec in deps.items():
            if name.startswith(SCOPE) and not str(spec).startswith("link:"):
                return True
    return False


def is_pnpm_project(root: Path, directory: str, manifest: dict[str, object]) -> bool:
    manager = manifest.get("packageManager")
    if isinstance(manager, str) and manager.startswith("pnpm@"):
        return True
    return (root / directory / "pnpm-lock.yaml").is_file()


def slug_for(directory: str) -> str:
    return "root" if directory == "." else directory.replace("/", "-")


def select(changed_paths: list[str], root: Path) -> list[dict[str, str]]:
    chosen: dict[str, str] = {}
    for changed in changed_paths:
        directory = project_dir(changed)
        if directory is None:
            continue
        if not DIR_SHAPE.match(directory) or ".." in directory.split("/"):
            print(f"skipped {directory!r}: not a plain directory name", file=sys.stderr)
            continue
        manifest_path = root / directory / "package.json"
        if not manifest_path.is_file():
            continue  # deleted by the change
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            print(f"skipped {directory!r}: package.json is not readable JSON", file=sys.stderr)
            continue
        if not isinstance(manifest, dict):
            continue
        if not is_pnpm_project(root, directory, manifest):
            continue
        if not consumes_registry_scope(manifest):
            continue
        chosen[directory] = slug_for(directory)
    return [{"dir": d, "slug": chosen[d]} for d in sorted(chosen)]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="repository root to read manifests from")
    args = parser.parse_args(argv)
    paths = [p for p in sys.stdin.buffer.read().decode("utf-8", "replace").split("\0") if p]
    projects = select(paths, Path(args.root))
    if len(projects) > MAX_PROJECTS:
        print(f"{len(projects)} projects selected; the limit is {MAX_PROJECTS}", file=sys.stderr)
        return 1
    print(json.dumps(projects, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

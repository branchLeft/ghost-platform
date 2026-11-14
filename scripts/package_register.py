"""Fail a tree whose workflows or mirror manifest name a ghcr.io/branchleft package that is not on the register.

The register (registers/packages.json) lists each package the platform pushes, by its path under
ghcr.io/branchleft, with the visibility it is expected to have. A merge cannot introduce a new
package name until that name is on the register.

Usage: python3 scripts/package_register.py [--root DIR] [--register FILE]
Exit 0 when every name is registered, 1 with one line per unregistered name otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# A literal package path. A name followed by a variable (mirror-private/${name}) or a
# continuing path character does not match, so only fixed names are read.
NAME_RE = re.compile(
    r"ghcr\.io/branchleft/([A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*)(?![A-Za-z0-9_/${-])"
)
MIRROR_PREFIX = "mirror-private/"
VISIBILITIES = frozenset({"public", "private"})


def load_register(path: Path) -> dict[str, str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    names: dict[str, str] = {}
    for entry in data["packages"]:
        name = entry["name"]
        if name in names:
            raise ValueError(f"duplicate register entry: {name}")
        if entry["visibility"] not in VISIBILITIES:
            raise ValueError(
                f"{name}: visibility must be public or private, got {entry['visibility']!r}"
            )
        names[name] = entry["visibility"]
    return names


def workflow_names(root: Path) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for workflow in sorted((root / ".github" / "workflows").glob("*.yml")):
        for match in NAME_RE.finditer(workflow.read_text(encoding="utf-8")):
            name = match.group(1).rstrip(".")
            found.setdefault(name, set()).add(workflow.name)
    return found


def mirror_names(root: Path) -> list[str]:
    manifest = json.loads(
        (root / ".github" / "image-mirror" / "images.json").read_text(encoding="utf-8")
    )
    return [MIRROR_PREFIX + image["name"] for image in manifest["images"]]


def problems(root: Path, register: dict[str, str]) -> list[str]:
    out: list[str] = []
    for name, files in sorted(workflow_names(root).items()):
        if name not in register:
            out.append(
                f"{name}: named in {', '.join(sorted(files))} but not on the register"
            )
    for name in sorted(set(mirror_names(root))):
        if name not in register:
            out.append(f"{name}: in images.json but not on the register")
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--register", type=Path, default=None)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    register_path = args.register or root / "registers" / "packages.json"
    found = problems(root, load_register(register_path))
    for line in found:
        print(line)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

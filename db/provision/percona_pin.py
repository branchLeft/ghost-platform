#!/usr/bin/env python3
"""Print the Percona Server digest a db proof script pins.

The image mirror list .github/image-mirror/images.json is the one source. It
holds two percona-server entries for the same 8.0 release:

- ``index``: the image index, the digest the hosts pull (no ``platform`` key);
- ``amd64``: its linux/amd64 manifest, the digest the promotion gate pins
  (``platform`` is ``linux/amd64``).

Usage: python3 db/provision/percona_pin.py index|amd64
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

LIST = Path(__file__).resolve().parents[2] / ".github" / "image-mirror" / "images.json"
SOURCE = "docker.io/percona/percona-server"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
ROLES: dict[str, str | None] = {"index": None, "amd64": "linux/amd64"}


def load(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    images = data.get("images")
    if not isinstance(images, list):
        raise ValueError(f"{path}: images is not a list")
    return [entry for entry in images if isinstance(entry, dict)]


def digest_for(images: list[dict[str, Any]], role: str) -> str:
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}; use one of {', '.join(ROLES)}")
    want = ROLES[role]
    matches = [
        entry
        for entry in images
        if entry.get("source") == SOURCE and entry.get("platform") == want
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one percona-server {role} entry, found {len(matches)}")
    digest = matches[0].get("digest")
    if not isinstance(digest, str) or not DIGEST.match(digest):
        raise ValueError(f"percona-server {role} digest is not sha256:<64 hex>")
    return digest


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: percona_pin.py index|amd64", file=sys.stderr)
        return 2
    try:
        print(digest_for(load(LIST), argv[1]))
    except (OSError, ValueError) as err:
        print(f"percona_pin: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

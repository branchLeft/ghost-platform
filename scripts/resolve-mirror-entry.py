#!/usr/bin/env python3
"""Print the mirror reference and digest of the one list entry a workflow signs.

Usage:
    resolve-mirror-entry.py NAME UPSTREAM_TAG [--list PATH]

Prints `image=<registry>/<name>` and `digest=sha256:<64 hex>` on two lines, for
a workflow to append to $GITHUB_OUTPUT. Exit 0 on exactly one match, 1 on none
or several, 2 on a bad list. See scripts/resolve-mirror-entry.md.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_mirror():
    spec = importlib.util.spec_from_file_location("mirror_images", HERE / "mirror-images.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mirror_images"] = module
    spec.loader.exec_module(module)
    return module


def resolve(registry: str, images: list[dict], name: str, tag: str) -> tuple[str, str]:
    """The (image, digest) of the single entry called `name` that lists `tag`."""
    found = [e for e in images if e["name"] == name and tag in e["upstreamTags"]]
    if len(found) != 1:
        raise LookupError(
            f"expected exactly one entry named {name} listing upstream tag {tag}, found {len(found)}"
        )
    return f"{registry}/{name}", found[0]["digest"]


def main(argv: list[str]) -> int:
    mirror = _load_mirror()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("name")
    parser.add_argument("upstream_tag")
    parser.add_argument("--list", type=Path, default=mirror.DEFAULT_LIST)
    args = parser.parse_args(argv)
    try:
        registry, images = mirror.load_list(args.list)
    except mirror.ListError as err:
        print(f"bad list: {err}", file=sys.stderr)
        return 2
    try:
        image, digest = resolve(registry, images, args.name, args.upstream_tag)
    except LookupError as err:
        print(str(err), file=sys.stderr)
        return 1
    print(f"image={image}")
    print(f"digest={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

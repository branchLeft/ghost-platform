#!/usr/bin/env python3
"""Copy every image in the mirror list to GHCR by digest and read each back.

Usage:
    mirror-images.py [--list PATH] [--crane PATH] [--dry-run] [--only NAME]

Idempotent: an entry already mirrored is verified, not copied again.
Exit 0 if every entry verified, 1 if any did not, 2 on a bad list.
See scripts/mirror-images.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

DEFAULT_LIST = Path(__file__).resolve().parent.parent / ".github" / "image-mirror" / "images.json"
DIGEST = re.compile(r"\Asha256:[0-9a-f]{64}\Z")
NAME = re.compile(r"\A[a-z0-9]+(-[a-z0-9]+)*\Z")
SOURCE = re.compile(r"\A[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+\Z")
REGISTRY = re.compile(r"\Aghcr\.io/branchleft/mirror\Z")
COPY_ATTEMPTS = 3

# (argv) -> (returncode, stdout bytes, stderr text)
Runner = Callable[[list[str]], tuple[int, bytes, str]]


class ListError(Exception):
    pass


def load_list(path: Path) -> tuple[str, list[dict]]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as err:
        raise ListError(f"cannot read {path}: {err}") from err
    registry = data.get("registry")
    if not isinstance(registry, str) or not REGISTRY.match(registry):
        raise ListError(f"registry must be ghcr.io/branchleft/mirror, got {registry!r}")
    images = data.get("images")
    if not isinstance(images, list) or not images:
        raise ListError("images must be a non-empty list")
    seen: set[tuple[str, str]] = set()
    for i, entry in enumerate(images):
        for key in ("name", "source", "digest", "licence", "redistribution", "licenceSource"):
            if not isinstance(entry.get(key), str) or not entry[key]:
                raise ListError(f"images[{i}] is missing {key}")
        tags = entry.get("upstreamTags")
        if not isinstance(tags, list) or not tags or not all(isinstance(t, str) and t for t in tags):
            raise ListError(f"images[{i}] upstreamTags must be a non-empty list of strings")
        pins = entry.get("hostPins", [])
        if not isinstance(pins, list) or not all(isinstance(p, str) and p for p in pins):
            raise ListError(f"images[{i}] hostPins must be a list of strings")
        if not NAME.match(entry["name"]):
            raise ListError(f"images[{i}] name {entry['name']!r} is not a lowercase package name")
        if not SOURCE.match(entry["source"]):
            raise ListError(f"images[{i}] source {entry['source']!r} is not a registry path without tag or digest")
        if not DIGEST.match(entry["digest"]):
            raise ListError(f"images[{i}] digest {entry['digest']!r} is not sha256:<64 hex>")
        if entry["redistribution"] not in ("permitted", "conditioned"):
            raise ListError(f"images[{i}] redistribution must be permitted or conditioned")
        key2 = (entry["name"], entry["digest"])
        if key2 in seen:
            raise ListError(f"images[{i}] repeats {entry['name']} {entry['digest']}")
        seen.add(key2)
    return registry, images


def mirror_tag(digest: str) -> str:
    return "d-" + digest.split(":", 1)[1][:12]


def refs(registry: str, entry: dict) -> tuple[str, str, str]:
    """Source ref, mirror tag ref, mirror digest ref."""
    source = f"{entry['source']}@{entry['digest']}"
    tagged = f"{registry}/{entry['name']}:{mirror_tag(entry['digest'])}"
    pinned = f"{registry}/{entry['name']}@{entry['digest']}"
    return source, tagged, pinned


def mirror_one(
    registry: str,
    entry: dict,
    crane: str,
    run: Runner,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> bool:
    source, tagged, pinned = refs(registry, entry)
    want = entry["digest"]

    code, out, _ = run([crane, "digest", tagged])
    if code == 0 and out.decode().strip() == want:
        log(f"already mirrored: {tagged}")
    else:
        copied = False
        for attempt in range(1, COPY_ATTEMPTS + 1):
            code, _, err = run([crane, "copy", source, tagged])
            if code == 0:
                copied = True
                break
            log(f"copy attempt {attempt}/{COPY_ATTEMPTS} failed for {source}: {err.strip()[:300]}")
            if attempt < COPY_ATTEMPTS:
                sleep(15 * attempt)
        if not copied:
            return False

    code, manifest, err = run([crane, "manifest", pinned])
    if code != 0:
        log(f"READ-BACK FAILED: {pinned}: {err.strip()[:300]}")
        return False
    got = "sha256:" + hashlib.sha256(manifest).hexdigest()
    if got != want:
        log(f"DIGEST MISMATCH: {pinned} serves {got}, list says {want}")
        return False
    log(f"verified {pinned} (from {entry['source']}, upstream tags {", ".join(entry["upstreamTags"])})")
    return True


def subprocess_runner(argv: list[str]) -> tuple[int, bytes, str]:
    done = subprocess.run(argv, capture_output=True, check=False)
    return done.returncode, done.stdout, done.stderr.decode(errors="replace")


def dry_run_lines(registry: str, images: list[dict], crane: str) -> list[str]:
    lines = []
    for entry in images:
        source, tagged, pinned = refs(registry, entry)
        lines.append(f"{crane} digest {tagged}   # skip the copy if this equals {entry['digest']}")
        lines.append(f"{crane} copy {source} {tagged}")
        lines.append(f"{crane} manifest {pinned}   # sha256 of the bytes must equal {entry['digest']}")
    return lines


def main(argv: list[str], run: Runner = subprocess_runner, sleep: Callable[[float], None] = time.sleep) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--list", type=Path, default=DEFAULT_LIST)
    parser.add_argument("--crane", default="crane")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only", help="mirror only the entries with this package name")
    args = parser.parse_args(argv)

    try:
        registry, images = load_list(args.list)
    except ListError as err:
        print(f"bad list: {err}", file=sys.stderr)
        return 2
    if args.only:
        images = [e for e in images if e["name"] == args.only]
        if not images:
            print(f"no entry named {args.only}", file=sys.stderr)
            return 2

    if args.dry_run:
        print("\n".join(dry_run_lines(registry, images, args.crane)))
        print(f"dry run: {len(images)} entries, nothing was run")
        return 0

    failed = [e for e in images if not mirror_one(registry, e, args.crane, run, sleep)]
    print(f"{len(images) - len(failed)}/{len(images)} entries verified")
    for entry in failed:
        print(f"FAILED: {entry['name']} {entry['digest']}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

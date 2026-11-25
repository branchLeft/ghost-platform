#!/usr/bin/env python3
"""Record the bundled-theme trees that shipped tenant images have installed.

A tenant's volume keeps the theme copy an earlier image seeded. The entrypoint
(docker-entrypoint.branchleft.sh, refresh_bundled_themes) replaces a stale copy
only when it is one of these trees, so a tenant's own changes are never replaced.
A tree is the one an image installs after the theme steps: the fetched bundle
(pinned in themes/manifest.json), then the footer patch, the font files and the
platform-fonts step, each where that commit's Dockerfile has its line (the font
files in every theme commit). The Dockerfile copies the
resulting list into the image as bundled-theme-pins.txt.

Usage, from the repository root:
    python3 themes/shipped_trees.py --since 6ef3ded1 --out themes/shipped-trees.txt

Each commit in the history that changed a theme input is replayed from a
`git archive` of its themes/ tree, with network access for the fetch (about
20 s a commit). Casper and Source are not fetched: they are symlinks into the
base image, which the entrypoint never refreshes, so they carry no entry.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEME_INPUTS = [
    "themes/manifest.json",
    "themes/fetch.mjs",
    "themes/verify.mjs",
    "themes/footer-credit",
    "themes/lib",
    "themes/licences",
    "Dockerfile",
]
PARTIAL = Path("partials") / "platform-footer-credit.hbs"


def git(*args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], check=True, capture_output=True
    ).stdout


def commits_since(since: str) -> list[str]:
    out = git("log", "--format=%H", "--reverse", f"{since}^..HEAD", "--", *THEME_INPUTS)
    return out.decode().split()


def tree_sha256(root: Path) -> str:
    """themes/lib/treehash.mjs treeSha256: sha256 of the sorted per-entry lines."""
    entries: list[tuple[str, str]] = []

    def walk(directory: Path, rel: str) -> None:
        for entry in os.scandir(directory):
            child = f"{rel}{entry.name}"
            if entry.is_symlink():
                entries.append((child, f"link:{os.readlink(entry.path)}  {child}\n"))
            elif entry.is_dir(follow_symlinks=False):
                walk(Path(entry.path), f"{child}/")
            elif entry.is_file(follow_symlinks=False):
                digest = hashlib.sha256(Path(entry.path).read_bytes()).hexdigest()
                entries.append((child, f"{digest}  {child}\n"))

    walk(root, "")
    entries.sort(key=lambda e: e[0])
    return hashlib.sha256("".join(line for _, line in entries).encode()).hexdigest()


def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(list(args), cwd=cwd, check=True, capture_output=True, text=True)


# The Dockerfile text each theme step is recognised by. Each step runs only where
# the commit's own Dockerfile has its line, so the replay is that commit's image.
FONTS_COPY = "cp -R /tmp/themes-bundle/fonts/."
FOOTER_APPLY = "footer-credit/apply.sh"
PLATFORM_FONTS = "--platform-fonts"


def installed_trees(commit: str, work: Path) -> dict[str, str]:
    """The installed tree of each bundled theme that this commit's image ships.

    Replays the Dockerfile's theme steps as that commit wrote them. Every step
    follows the Dockerfile text, and the bundle is checked against the commit's own
    manifest pins first, as verify.mjs checks it in the image build.
    """
    dockerfile = git("show", f"{commit}:Dockerfile").decode()
    tar = git("archive", commit, "themes")
    src = work / "src"
    src.mkdir()
    with tarfile.open(fileobj=io.BytesIO(tar)) as archive:
        archive.extractall(src, filter="data")
    themes = src / "themes"
    bundle = work / "bundle"
    run("node", str(themes / "fetch.mjs"), "--out", str(bundle))
    post = work / "post"
    shutil.copytree(bundle / "themes", post, symlinks=True)

    # verify.mjs: each bundled theme is the manifest's pinned tree before any step.
    manifest = json.loads((themes / "manifest.json").read_text())
    for theme in manifest["themes"]:
        if theme["source"] == "base-image":
            continue
        got = tree_sha256(post / theme["name"])
        if got != theme["treeSha256"]:
            raise SystemExit(f"{commit[:8]}: {theme['name']} bundle differs from its pin")

    # The footer patch, as footer-credit/apply.sh applies it, for each bundled
    # theme present (casper and source are not in the bundle; see the docstring).
    footer = themes / "footer-credit"
    if FOOTER_APPLY in dockerfile:
        for patch in sorted(footer.glob("*.patch")):
            theme_dir = post / patch.stem
            if not theme_dir.is_dir():
                continue
            run("patch", "-s", "-F0", "-p1", "-i", str(patch), cwd=theme_dir)
            for stray in theme_dir.rglob("*.orig"):
                stray.unlink()
            for stray in theme_dir.rglob("*.rej"):
                stray.unlink()
            (theme_dir / "partials").mkdir(exist_ok=True)
            shutil.copy(footer / "platform-footer-credit.hbs", theme_dir / PARTIAL)

    # The font files: the Dockerfile's theme loop copied them into every theme from
    # the first theme commit on, so a commit that bundles themes must have the line.
    if "fetch.mjs --out" in dockerfile:
        if FONTS_COPY not in dockerfile:
            raise SystemExit(f"{commit[:8]}: the Dockerfile has no font copy line")
        for theme_dir in sorted(p for p in post.iterdir() if p.is_dir()):
            fonts_dir = theme_dir / "assets" / "platform-fonts"
            fonts_dir.mkdir(parents=True, exist_ok=True)
            shutil.copytree(bundle / "fonts", fonts_dir, dirs_exist_ok=True)

    # The platform-fonts step (fetch.mjs --platform-fonts), where the Dockerfile has it.
    if PLATFORM_FONTS in dockerfile:
        for theme_dir in sorted(p for p in post.iterdir() if p.is_dir()):
            run("node", str(themes / "fetch.mjs"), "--platform-fonts", str(theme_dir))

    trees = {p.name: tree_sha256(p) for p in sorted(post.iterdir()) if p.is_dir()}
    print(
        f"{commit[:8]}: footer={FOOTER_APPLY in dockerfile} "
        f"fonts={FONTS_COPY in dockerfile} platform-fonts={PLATFORM_FONTS in dockerfile} "
        f"themes={len(trees)} pins=match",
        file=sys.stderr,
    )
    return trees


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--since", required=True, help="first commit whose theme inputs count")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    seen: set[tuple[str, str]] = set()
    lines: list[str] = []
    for commit in commits_since(args.since):
        # resolve(): fetch.mjs runs only when argv[1] is the real path of the script.
        with tempfile.TemporaryDirectory(prefix="shipped-trees-") as tmp:
            trees = installed_trees(commit, Path(tmp).resolve())
        print(f"{commit[:8]}: {len(trees)} themes", file=sys.stderr)
        for name, digest in trees.items():
            if (name, digest) not in seen:
                seen.add((name, digest))
                lines.append(f"{name} {digest}\n")
    args.out.write_text("".join(lines))
    print(f"wrote {len(lines)} trees to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

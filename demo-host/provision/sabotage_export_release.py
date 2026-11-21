#!/usr/bin/env python3
"""Sabotage proof for export_release: break each refusal in a scratch copy and
require the suite red, then the untouched copy green.

Usage: sabotage_export_release.py

Some refusals are held twice on purpose (a symlink is refused by `O_NOFOLLOW`
and again by the identity check; a wrong digest is refused by the comparison
and the format check is only its clearer message), so a sabotage that must
turn the suite red drops every layer that holds the same property.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent

IDENTITY_CHECK = "    if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):\n"

# (name, [(old text, new text), ...]) -- each edits export_release.py only, and
# each old text must occur exactly once.
SABOTAGES: list[tuple[str, list[tuple[str, str]]]] = [
    (
        "remove without comparing the confirmed digest",
        [("    if actual != confirmed:\n", "    if False:\n")],
    ),
    (
        "accept any file name",
        [
            ("    if match is None:\n", "    if False:\n"),
            ('    return match.group("stem")\n', "    return archive\n"),
        ],
    ),
    (
        "accept a directory others can enter",
        [("    if info.st_mode & 0o077:\n", "    if False:\n")],
    ),
    (
        "follow a symlink named like the archive",
        [
            ("os.O_RDONLY | os.O_NOFOLLOW", "os.O_RDONLY"),
            (IDENTITY_CHECK, "    if False:\n"),
        ],
    ),
    (
        "skip the check that the name is still the hashed file",
        [(IDENTITY_CHECK, "    if False:\n")],
    ),
    (
        "accept a directory in place of the archive",
        [("        if not stat.S_ISREG(opened.st_mode):\n", "        if False:\n")],
    ),
    (
        "remove the archive before its manifest",
        [
            (
                "    if os.path.lexists(manifest_path):\n        os.unlink(manifest_path)\n    os.unlink(archive_path)\n",
                "    os.unlink(archive_path)\n    if os.path.lexists(manifest_path):\n        os.unlink(manifest_path)\n",
            )
        ],
    ),
    (
        "leave the manifest behind",
        [("    if os.path.lexists(manifest_path):\n        os.unlink(manifest_path)\n", "")],
    ),
    (
        "report an archive that is still there as removed",
        [
            (
                '    if os.path.lexists(archive_path):\n        raise ReleaseRefused(f"{archive} is still in',
                '    if False:\n        raise ReleaseRefused(f"{archive} is still in',
            )
        ],
    ),
    (
        "answer a missing archive as a plain refusal",
        [
            (
                'raise ReleaseRefused(f"{archive} is not in {dest_dir}", EXIT_NOTHING_THERE)',
                'raise ReleaseRefused(f"{archive} is not in {dest_dir}")',
            )
        ],
    ),
    (
        "exit zero on a refusal",
        [("        return refused.code\n", "        return EXIT_REMOVED\n")],
    ),
]


def run_suite(directory: pathlib.Path) -> bool:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_export_release"],
        cwd=directory,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def main() -> int:
    failures = 0
    for name, edits in SABOTAGES:
        with tempfile.TemporaryDirectory() as tmp:
            scratch = pathlib.Path(tmp) / "provision"
            shutil.copytree(HERE, scratch, ignore=shutil.ignore_patterns("__pycache__"))
            target = scratch / "export_release.py"
            source = target.read_text(encoding="utf-8")
            broken = [old for old, _new in edits if source.count(old) != 1]
            if broken:
                print(f"BROKEN SABOTAGE (pattern not found exactly once): {name}")
                failures += 1
                continue
            for old, new in edits:
                source = source.replace(old, new)
            target.write_text(source, encoding="utf-8")
            red = not run_suite(scratch)
        print(f"{'RED' if red else 'NOT RED'}: {name}")
        failures += 0 if red else 1
    green = run_suite(HERE)
    print(f"{'GREEN' if green else 'NOT GREEN'}: unsabotaged suite")
    return 0 if failures == 0 and green else 1


if __name__ == "__main__":
    raise SystemExit(main())

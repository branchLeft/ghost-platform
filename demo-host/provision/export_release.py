#!/usr/bin/env python3
"""Removes a promotion's encrypted export from the demo host once `ops1` has
confirmed it pulled exactly those bytes.

See export_release.md for what counts as the confirmation, why a failed pull
leaves the export where it is, and what is not wired yet. Every refusal exits
non-zero, prints one `REFUSED:` line and removes nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys
from typing import Sequence

# What the export bundler writes into its destination directory, per run:
# `<tenant id>-export-<generated at>.tar.age` and the manifest sidecar beside
# it, `<same stem>.manifest.json` (services/export-bundler exportRunner.ts:
# the timestamp is the ISO time with `:` and `.` removed). The pattern is the
# bundler's own shape and nothing wider, so this script can never be pointed
# at a file the bundler did not write.
ARCHIVE_SUFFIX = ".tar.age"
MANIFEST_SUFFIX = ".manifest.json"
ARCHIVE_NAME = re.compile(
    r"^(?P<stem>[A-Za-z0-9][A-Za-z0-9_-]{0,62}-export-"
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6,9}Z)" + re.escape(ARCHIVE_SUFFIX) + r"$"
)
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

EXIT_REMOVED = 0
EXIT_REFUSED = 2
EXIT_NOTHING_THERE = 3

_CHUNK = 1024 * 1024


class ReleaseRefused(Exception):
    """Raised for anything that makes removing the export unsafe. It is the
    only thing `main` turns into a refusal; anything else is a defect and
    surfaces as a traceback, never as a quiet success."""

    def __init__(self, message: str, code: int = EXIT_REFUSED) -> None:
        super().__init__(message)
        self.code = code


def archive_stem(archive: str) -> str:
    """The bundler's file stem for `archive`, or a refusal when the name is
    not one the bundler writes (a path, a `..`, another suffix, a glob)."""
    match = ARCHIVE_NAME.match(archive)
    if match is None:
        raise ReleaseRefused(
            f"{archive!r} is not an export archive name "
            "(<id>-export-<time>.tar.age, no directory part)"
        )
    return match.group("stem")


def check_confirmation(pulled_sha256: str) -> str:
    """The digest `ops1` reports for the bytes it pulled, as lowercase hex, or
    a refusal. An empty, short, upper-case or non-hex value is not a
    confirmation: nothing is removed on a guess."""
    if SHA256_HEX.match(pulled_sha256) is None:
        raise ReleaseRefused(
            "the pull confirmation is not a 64-character lowercase SHA-256"
        )
    return pulled_sha256


def check_private_dir(dest_dir: str) -> None:
    """The export directory must be an absolute path to a real directory (not a
    symlink) that only its owner can enter, as the bundler makes it (0700).
    Anything looser was not made by the bundler and is not touched."""
    if not os.path.isabs(dest_dir):
        raise ReleaseRefused(f"the export directory {dest_dir!r} is not an absolute path")
    try:
        info = os.lstat(dest_dir)
    except OSError as exc:
        raise ReleaseRefused(f"the export directory {dest_dir!r} cannot be read ({exc.strerror})") from exc
    if not stat.S_ISDIR(info.st_mode):
        raise ReleaseRefused(f"the export directory {dest_dir!r} is not a real directory")
    if info.st_mode & 0o077:
        raise ReleaseRefused(
            f"the export directory {dest_dir!r} is accessible to more than its owner "
            "(the bundler makes it 0700)"
        )


def listing(dest_dir: str) -> list[str]:
    """The names in the export directory, sorted: what the run prints before
    and after, so the removal can be read off the output."""
    return sorted(os.listdir(dest_dir))


def sha256_of_open_file(fd: int) -> str:
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, _CHUNK)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)


def release(dest_dir: str, archive: str, pulled_sha256: str, out: list[str] | None = None) -> None:
    """Remove `archive` (and its manifest sidecar) from `dest_dir`, but only
    when the SHA-256 of the archive's bytes, read now, equals `pulled_sha256`.

    The archive goes last: while it is there the export is not released, so a
    run cut short between the two removals is finished by running it again.
    Raises ReleaseRefused, and removes nothing, for every other case."""
    lines = out if out is not None else []
    stem = archive_stem(archive)
    confirmed = check_confirmation(pulled_sha256)
    check_private_dir(dest_dir)
    archive_path = os.path.join(dest_dir, archive)
    manifest_path = os.path.join(dest_dir, stem + MANIFEST_SUFFIX)

    lines.append("before: " + ", ".join(listing(dest_dir)))
    try:
        fd = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError as exc:
        raise ReleaseRefused(f"{archive} is not in {dest_dir}", EXIT_NOTHING_THERE) from exc
    except OSError as exc:
        raise ReleaseRefused(f"{archive} cannot be opened as a plain file ({exc.strerror})") from exc
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise ReleaseRefused(f"{archive} is not a regular file")
        actual = sha256_of_open_file(fd)
    finally:
        os.close(fd)
    if actual != confirmed:
        raise ReleaseRefused(
            f"the confirmed SHA-256 does not match {archive} here; it is left in place for a retry"
        )
    # The name must still be the file that was hashed: a swap between the read
    # and the removal would otherwise delete a file nobody confirmed.
    current = os.lstat(archive_path)
    if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
        raise ReleaseRefused(f"{archive} changed while it was being checked; nothing was removed")

    if os.path.lexists(manifest_path):
        os.unlink(manifest_path)
    os.unlink(archive_path)
    dir_fd = os.open(dest_dir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    if os.path.lexists(archive_path):
        raise ReleaseRefused(f"{archive} is still in {dest_dir} after its removal")
    lines.append(f"removed: {archive} sha256 {actual}")
    lines.append("after: " + ", ".join(listing(dest_dir)))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Remove a confirmed-pulled encrypted export from the demo host."
    )
    parser.add_argument("--dest-dir", required=True, help="the bundler's --dest-dir (absolute)")
    parser.add_argument("--archive", required=True, help="the archive's file name, no directory")
    parser.add_argument(
        "--pulled-sha256",
        required=True,
        help="the SHA-256 ops1 computed over the bytes it pulled",
    )
    args = parser.parse_args(argv)
    lines: list[str] = []
    try:
        release(args.dest_dir, args.archive, args.pulled_sha256, lines)
    except ReleaseRefused as refused:
        for line in lines:
            print(f"export-release: {line}")
        print(f"REFUSED: {refused}", file=sys.stderr)
        return refused.code
    for line in lines:
        print(f"export-release: {line}")
    return EXIT_REMOVED


if __name__ == "__main__":
    sys.exit(main())

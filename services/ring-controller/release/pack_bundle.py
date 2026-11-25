"""Assemble and pack the ring-controller release bundle, deterministically.

The bundle is the file the ring_controller_host role (shared-infra) downloads by URL and
holds to a SHA-256 digest. Its contract, fixed by that role and by the controller's unit
file: a gzipped tarball with a regular executable at ``bin/ring-controller``. The compiled
controller goes under ``lib/``.

Why the bytes are fixed: the role pins a digest, so the same inputs must always give the
same file. Member order is byte-sorted, every time and owner is zero, every mtime is zero,
the permission bits are set here rather than taken from the disk, and the gzip header
carries no name and no time. ``test_pack_bundle.py`` proves the determinism.

Usage:
    pack_bundle.py --dist DIR --launcher FILE --version X.Y.Z --out DIR
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Sequence

VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
BINARY_RELATIVE = "bin/ring-controller"
LIB_RELATIVE = "lib"
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755


class BundleError(Exception):
    """A refusal. The message names the input at fault and never a secret."""


def bundle_name(version: str) -> str:
    # .tgz, not .tar.gz: the shared attest action accepts only the .tgz suffix.
    return f"ring-controller-bundle-{version}.tgz"


def check_version(version: str) -> None:
    if VERSION_PATTERN.fullmatch(version) is None:
        raise BundleError(f"version {version!r} is not MAJOR.MINOR.PATCH")


def assemble(dist_dir: Path, launcher: Path, stage: Path) -> None:
    """Lay out the bundle tree under ``stage``: ``bin/ring-controller`` and ``lib/``."""
    if not dist_dir.is_dir():
        raise BundleError(f"compiled output {dist_dir} is not a directory; run the build first")
    if not launcher.is_file():
        raise BundleError(f"launcher {launcher} is not a regular file")
    binary = stage / BINARY_RELATIVE
    binary.parent.mkdir(parents=True)
    shutil.copyfile(launcher, binary)
    os.chmod(binary, EXECUTABLE_MODE)
    shutil.copytree(dist_dir, stage / LIB_RELATIVE, symlinks=True)
    for path in (stage / LIB_RELATIVE).rglob("*"):
        if path.is_symlink():
            raise BundleError(f"compiled output holds a link at {path.relative_to(stage).as_posix()}")


def member_names(stage: Path) -> list[str]:
    """Every file under ``stage`` as a POSIX name, byte-sorted. Links and specials are refused."""
    names: list[str] = []
    for path in stage.rglob("*"):
        rel = path.relative_to(stage).as_posix()
        if path.is_symlink():
            raise BundleError(f"the bundle tree holds a link at {rel}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise BundleError(f"the bundle tree holds a special file at {rel}")
        names.append(rel)
    return sorted(names, key=lambda name: name.encode("utf-8"))


def _member_info(name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.type = tarfile.REGTYPE
    info.mode = EXECUTABLE_MODE if name.startswith("bin/") else FILE_MODE
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    return info


def pack(stage: Path, version: str, out_dir: Path) -> Path:
    """Pack the tree under ``stage`` into ``out_dir``, with its ``.sha256`` file. Returns the tarball."""
    check_version(version)
    if not (stage / BINARY_RELATIVE).is_file():
        raise BundleError(f"the bundle tree has no {BINARY_RELATIVE}")
    names = member_names(stage)
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
            for name in names:
                data = (stage / name).read_bytes()
                tar.addfile(_member_info(name, len(data)), io.BytesIO(data))
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / bundle_name(version)
    target.write_bytes(buffer.getvalue())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (out_dir / (target.name + ".sha256")).write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    return target


def check_bundle(bundle: Path) -> None:
    """Re-read a bundle and refuse unless it has the contract: the binary, a regular executable."""
    with tarfile.open(bundle, mode="r:gz") as tar:
        try:
            info = tar.getmember(BINARY_RELATIVE)
        except KeyError as err:
            raise BundleError(f"the bundle has no {BINARY_RELATIVE}") from err
        if not info.isreg():
            raise BundleError(f"{BINARY_RELATIVE} in the bundle is not a regular file")
        if info.mode & 0o111 == 0:
            raise BundleError(f"{BINARY_RELATIVE} in the bundle is not executable")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description="Pack the ring-controller bundle.")
    parser.add_argument("--dist", type=Path, required=True, help="the compiled controller (tsc output)")
    parser.add_argument("--launcher", type=Path, required=True, help="the bin/ring-controller program")
    parser.add_argument("--version", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        check_version(args.version)
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp) / "bundle"
            assemble(args.dist, args.launcher, stage)
            target = pack(stage, args.version, args.out)
        check_bundle(target)
    except BundleError as err:
        print(f"refusing: {err}", file=sys.stderr)
        return 1
    print(f"packed {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

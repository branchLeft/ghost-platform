"""Tests for pack_bundle.py: determinism, the bundle contract, and the refusals.

Run from this directory: python3 -m unittest -v test_pack_bundle
"""

from __future__ import annotations

import hashlib
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

import pack_bundle


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_dist(root: Path, order: list[str], stamp: int) -> Path:
    """A compiled-output tree with the given files, created in ``order``, all stamped ``stamp``."""
    dist = root / "dist"
    files = {
        "index.js": "export const a = 1;\n",
        "rings.js": "export const r = 2;\n",
        "deep/gates.js": "export const g = 3;\n",
    }
    for name in order:
        target = dist / name
        _write(target, files[name])
        os.utime(target, (stamp, stamp))
    return dist


def _make_launcher(root: Path, mode: int = 0o644) -> Path:
    launcher = root / "ring-controller"
    _write(launcher, "#!/bin/sh\nexit 69\n")
    os.chmod(launcher, mode)
    return launcher


class PackBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _pack(self, dist: Path, launcher: Path, out: Path, version: str = "0.1.1") -> Path:
        stage = self.root / f"stage-{out.name}"
        pack_bundle.assemble(dist, launcher, stage)
        return pack_bundle.pack(stage, version, out)

    def test_two_packs_of_the_same_tree_are_byte_identical(self) -> None:
        # Opposite creation order and different times: the bytes must not care.
        names = ["index.js", "rings.js", "deep/gates.js"]
        dist_a = _make_dist(self.root / "a", names, stamp=1_000_000_000)
        dist_b = _make_dist(self.root / "b", list(reversed(names)), stamp=2_000_000_000)
        launcher_a = _make_launcher(self.root / "a")
        launcher_b = _make_launcher(self.root / "b", mode=0o600)
        first = self._pack(dist_a, launcher_a, self.root / "out-a")
        second = self._pack(dist_b, launcher_b, self.root / "out-b")
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_the_digest_file_names_the_bytes_it_sits_beside(self) -> None:
        dist = _make_dist(self.root, ["index.js"], stamp=1)
        tarball = self._pack(dist, _make_launcher(self.root), self.root / "out")
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        sidecar = (self.root / "out" / (tarball.name + ".sha256")).read_text(encoding="utf-8")
        self.assertEqual(sidecar, f"{digest}  {tarball.name}\n")

    def test_the_bundle_holds_the_binary_as_a_regular_executable(self) -> None:
        dist = _make_dist(self.root, ["index.js", "rings.js", "deep/gates.js"], stamp=5)
        tarball = self._pack(dist, _make_launcher(self.root), self.root / "out")
        with tarfile.open(tarball, mode="r:gz") as tar:
            names = tar.getnames()
            binary = tar.getmember(pack_bundle.BINARY_RELATIVE)
            self.assertTrue(binary.isreg())
            self.assertEqual(binary.mode, 0o755)
            self.assertEqual((binary.uid, binary.gid, binary.mtime), (0, 0, 0))
            self.assertIn("lib/rings.js", names)
            self.assertEqual(names, sorted(names))
        pack_bundle.check_bundle(tarball)

    def test_the_bundle_name_ends_in_tgz_as_the_attest_action_requires(self) -> None:
        name = pack_bundle.bundle_name("1.2.3")
        self.assertEqual(name, "ring-controller-bundle-1.2.3.tgz")
        self.assertTrue(name.endswith(".tgz"))

    def test_a_version_that_is_not_semver_is_refused(self) -> None:
        dist = _make_dist(self.root, ["index.js"], stamp=1)
        with self.assertRaisesRegex(pack_bundle.BundleError, "not MAJOR.MINOR.PATCH"):
            self._pack(dist, _make_launcher(self.root), self.root / "out", version="0.1")

    def test_a_missing_launcher_is_refused(self) -> None:
        dist = _make_dist(self.root, ["index.js"], stamp=1)
        with self.assertRaisesRegex(pack_bundle.BundleError, "not a regular file"):
            self._pack(dist, self.root / "absent", self.root / "out")

    def test_a_link_in_the_compiled_output_is_refused(self) -> None:
        dist = _make_dist(self.root, ["index.js"], stamp=1)
        os.symlink(dist / "index.js", dist / "lib-link.js")
        with self.assertRaisesRegex(pack_bundle.BundleError, "holds a link"):
            self._pack(dist, _make_launcher(self.root), self.root / "out")

    def test_a_bundle_with_no_binary_is_refused_on_pack(self) -> None:
        stage = self.root / "stage"
        _write(stage / "lib" / "index.js", "x\n")
        with self.assertRaisesRegex(pack_bundle.BundleError, "has no bin/ring-controller"):
            pack_bundle.pack(stage, "0.1.1", self.root / "out")

    def test_a_bundle_whose_binary_lost_its_executable_bit_is_refused(self) -> None:
        stage = self.root / "stage"
        _write(stage / "bin" / "ring-controller", "x\n")
        os.chmod(stage / "bin" / "ring-controller", 0o644)
        # pack() sets the mode itself, whatever the disk says.
        tarball = pack_bundle.pack(stage, "0.1.1", self.root / "out")
        with tarfile.open(tarball, mode="r:gz") as tar:
            self.assertEqual(tar.getmember(pack_bundle.BINARY_RELATIVE).mode, 0o755)
        # A bundle built with the binary stripped of its executable bit is refused.
        bare = self.root / "bare.tar.gz"
        with tarfile.open(bare, mode="w:gz") as tar:
            info = tarfile.TarInfo(pack_bundle.BINARY_RELATIVE)
            data = b"x\n"
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
        with self.assertRaisesRegex(pack_bundle.BundleError, "not executable"):
            pack_bundle.check_bundle(bare)


if __name__ == "__main__":
    unittest.main()

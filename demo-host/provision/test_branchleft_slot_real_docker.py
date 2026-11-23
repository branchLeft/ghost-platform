#!/usr/bin/env python3
"""Real-Docker proof for the tag `branchleft_slot.py`'s `load` verb gives a loaded image.

The unit tests in `test_branchleft_slot.py` use a stand-in `docker`. This one
runs the real engine through the real `RealSlotOps.load_image`: build a
throwaway image, `docker save` it by its digest (what the signed push sends),
remove it, load the archive, and require that `SLOT_IMAGE_NAME@<digest>`
resolves, while another digest does not and an archive of a *named* image is
refused and leaves that name unresolved. Given a pin file that pins the loaded
digest as the drain sidecar, the sidecar's `name@<digest>` resolves instead of
the slot image's.

It needs a Docker whose image store is containerd's (on the classic store the
id of an image is not its manifest digest, so `name@digest` cannot resolve and
`load` fails closed) and GNU `timeout`. It is skipped unless
`BRANCHLEFT_REAL_DOCKER=1`, because it builds, saves, removes and loads images
on whatever engine it finds. Why, and how to run it: test_branchleft_slot.md.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

import branchleft_slot as bs

_DOCKER_TIMEOUT_SECONDS = 180


def _docker(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=_DOCKER_TIMEOUT_SECONDS,
        check=False,
    )


def _containerd_image_store() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        shown = _docker("info", "--format", "{{.DriverStatus}}")
    except (subprocess.TimeoutExpired, OSError):
        return False
    return shown.returncode == 0 and "io.containerd.snapshotter" in shown.stdout


@unittest.skipUnless(os.environ.get("BRANCHLEFT_REAL_DOCKER") == "1", "set BRANCHLEFT_REAL_DOCKER=1")
@unittest.skipUnless(shutil.which("timeout"), "needs GNU coreutils timeout")
@unittest.skipUnless(_containerd_image_store(), "needs Docker with the containerd image store")
class LoadTagsTheImageForRealTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patch = mock.patch(
            "branchleft_slot.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=os.getuid())
        )
        patch.start()
        self.addCleanup(patch.stop)
        self._removals: list[str] = []
        self.addCleanup(self._remove_what_the_test_made)

        self.probe_name = f"branchleft-probe-{uuid.uuid4().hex[:12]}:t"
        self._removals.append(self.probe_name)
        built = _docker(
            "build", "-q", "-t", self.probe_name, "-",
            stdin=f"FROM scratch\nLABEL probe={uuid.uuid4().hex}\n",
        )
        self.assertEqual(built.returncode, 0, built.stderr)
        shown = _docker("image", "inspect", "--format", "{{.Id}}", self.probe_name)
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.digest = shown.stdout.strip()
        self.assertRegex(self.digest, r"^sha256:[0-9a-f]{64}$")
        self.slot_tag = f"{bs.SLOT_IMAGE_NAME}:{self.digest.replace(':', '-')}"
        self._removals.append(self.slot_tag)
        self.sidecar_tag = f"{bs.SIDECAR_IMAGE_NAME}:{self.digest.replace(':', '-')}"
        self._removals.append(self.sidecar_tag)
        # No pin file unless a test writes one, owned by "root" = this process.
        self.pin_path = os.path.join(self._tmp.name, "demo-sidecar.image.env")
        pin = mock.patch.multiple(
            "branchleft_slot",
            SIDECAR_IMAGE_ENV_PATH=self.pin_path,
            SIDECAR_IMAGE_ENV_OWNER_UID=os.getuid(),
        )
        pin.start()
        self.addCleanup(pin.stop)
        self.archive = os.path.join(self._tmp.name, "image.tar")

    def _remove_what_the_test_made(self) -> None:
        for reference in self._removals:
            _docker("rmi", "--force", reference)

    def _save_then_remove(self, reference: str) -> None:
        saved = _docker("save", "-o", self.archive, reference)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        for removed in (self.probe_name, self.slot_tag, self.sidecar_tag):
            _docker("rmi", "--force", removed)
        self.assertNotEqual(_docker("image", "inspect", self.digest).returncode, 0)

    def _resolves(self, reference: str) -> bool:
        return _docker("image", "inspect", reference).returncode == 0

    def test_an_image_saved_by_digest_resolves_by_name_and_digest_after_load(self) -> None:
        self._save_then_remove(self.digest)

        bs.RealSlotOps().load_image(self.archive)

        self.assertTrue(self._resolves(f"{bs.SLOT_IMAGE_NAME}@{self.digest}"))

    def test_a_different_digest_does_not_resolve_under_the_slot_image_name(self) -> None:
        self._save_then_remove(self.digest)

        bs.RealSlotOps().load_image(self.archive)

        other = "sha256:" + "0" * 64
        self.assertNotEqual(other, self.digest)
        self.assertFalse(self._resolves(f"{bs.SLOT_IMAGE_NAME}@{other}"))

    def test_the_image_the_host_pins_as_the_sidecar_resolves_under_the_sidecar_name(self) -> None:
        with open(self.pin_path, "w", encoding="ascii") as handle:
            handle.write(f"{bs.SIDECAR_IMAGE_VARIABLE}={bs.SIDECAR_IMAGE_NAME}@{self.digest}\n")
        os.chmod(self.pin_path, 0o644)
        self._save_then_remove(self.digest)

        bs.RealSlotOps().load_image(self.archive)

        self.assertTrue(self._resolves(f"{bs.SIDECAR_IMAGE_NAME}@{self.digest}"))
        self.assertFalse(self._resolves(f"{bs.SLOT_IMAGE_NAME}@{self.digest}"))

    def test_an_archive_of_a_named_image_is_refused_and_leaves_the_slot_name_unresolved(self) -> None:
        self._save_then_remove(self.probe_name)

        with self.assertRaises(bs.RefusedImage):
            bs.RealSlotOps().load_image(self.archive)

        self.assertFalse(self._resolves(f"{bs.SLOT_IMAGE_NAME}@{self.digest}"))
        self.assertFalse(self._resolves(self.slot_tag))


if __name__ == "__main__":
    unittest.main()

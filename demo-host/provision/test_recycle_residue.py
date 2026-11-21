#!/usr/bin/env python3
"""The host half of the recycle test (demo recycle): reset a slot that holds a
previous occupant's data, then check nothing of it remains.

`branchleft-slot` runs for real (`main`, `RealSlotOps`) against one scratch tree
standing in for the host; only `systemctl` is stubbed. The residue check is the
control: each kind of residue is planted and must be named, and
`sabotage_recycle_residue.py` loosens the wrapper's wipe and requires this suite
red.
"""

from __future__ import annotations

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import branchleft_slot as bs
import recycle_residue as rr

SLOT = "1"
CONTENT = "ghost-demo-2-content"
COMPOSE = (
    "volumes:\n"
    "  ghost-demo-30002-data:\n    external: true\n"
    f"  {CONTENT}:\n    external: true\n"
    "  ghost-demo-2-adapters:\n    external: true\n"
)


class RecycleResidueTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.volumes = tmp / "volumes"
        self.slot_dir = tmp / "demo-1"
        self.etc = tmp / "etc"
        self.elsewhere = tmp / "elsewhere"
        for path in (self.volumes, self.slot_dir, self.etc, self.elsewhere):
            path.mkdir()
        (self.elsewhere / "not-ours.txt").write_text("another slot's file")
        for patch in (
            mock.patch.object(bs, "LOCK_DIR", str(tmp / "lock")),
            mock.patch.object(bs, "SLOT_DIR", str(tmp / "demo-{slot}")),
            mock.patch.object(bs, "ETC_DIR", str(self.etc)),
            mock.patch.object(bs, "DOCKER_VOLUME_ROOT", self.volumes),
            mock.patch("branchleft_slot.subprocess.run"),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.data = self.volumes / "ghost-demo-30002-data" / "_data"
        self.content = self.volumes / CONTENT / "_data"
        for path in (self.data, self.content):
            path.mkdir(parents=True)

    def occupy(self) -> None:
        """A previous occupant's footprint, in every place the reset must empty."""
        (self.slot_dir / "compose.yml").write_text(COMPOSE)
        (self.data / "ghost.db").write_text("visitor's site")
        (self.data / ".hidden-wal").write_text("visitor's site")
        (self.content / "images" / "2026" / "11").mkdir(parents=True)
        (self.content / "images" / "2026" / "11" / "photo.jpg").write_text("visitor's photo")
        (self.content / "images" / ".dotfile").write_text("x")
        os.symlink(self.elsewhere / "not-ours.txt", self.content / "link")
        (self.slot_dir / "ghost.env").write_text("GHOST_BULK_EMAIL_API_KEY=visitor-key")
        (self.slot_dir / "nested").mkdir()
        (self.slot_dir / "nested" / ".stale").write_text("x")
        for colour in ("a", "b"):
            (self.etc / f"demo-1-{colour}.env").write_text("GHOST_BULK_EMAIL_API_KEY=visitor-key")

    def reset(self) -> None:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = bs.main([SLOT, "reset"])
        self.assertEqual(code, 0, err.getvalue())

    def residue(self) -> list[str]:
        return rr.residue_of(SLOT, CONTENT)

    def test_an_occupied_slot_shows_residue_in_every_place_before_the_reset(self):
        self.occupy()
        found = self.residue()
        self.assertEqual(len(found), 5, found)
        self.assertTrue(found[0].startswith("slot directory: still holds"))
        self.assertIn("environment file: demo-1-a.env is still there", found)
        self.assertIn("environment file: demo-1-b.env is still there", found)
        self.assertTrue(any(line.startswith("data volume: still holds") for line in found))
        self.assertTrue(any(line.startswith("content volume: still holds") for line in found))

    def test_after_the_reset_nothing_of_the_previous_occupant_remains(self):
        self.occupy()
        self.reset()
        self.assertEqual(self.residue(), [])
        # What belongs to nobody on the slot is exactly where it was.
        self.assertEqual((self.elsewhere / "not-ours.txt").read_text(), "another slot's file")

    def test_a_slot_that_was_never_occupied_has_no_residue(self):
        self.assertEqual(rr.residue_of(SLOT, None), [])
        self.assertEqual(self.residue(), [])

    def test_a_file_left_in_the_data_volume_is_named(self):
        self.reset()
        (self.data / "ghost.db").write_text("left behind")
        self.assertEqual(self.residue(), ["data volume: still holds ghost.db"])

    def test_a_dotfile_deep_in_the_content_volume_is_named(self):
        self.reset()
        (self.content / "a" / "b").mkdir(parents=True)
        (self.content / "a" / "b" / ".left").write_text("x")
        found = self.residue()
        self.assertEqual(len(found), 1, found)
        self.assertTrue(found[0].startswith("content volume: still holds "), found)
        self.assertIn(os.path.join("a", "b", ".left"), found[0])

    def test_a_stale_environment_file_is_named(self):
        self.reset()
        (self.etc / "demo-1-b.env").write_text("stale")
        self.assertEqual(self.residue(), ["environment file: demo-1-b.env is still there"])

    def test_a_file_left_in_the_slot_directory_is_named(self):
        self.reset()
        (self.slot_dir / ".left").write_text("x")
        self.assertEqual(self.residue(), ["slot directory: still holds .left"])

    def test_a_planted_link_is_named_and_never_followed(self):
        self.reset()
        os.symlink(self.elsewhere, self.data / "link-to-dir")
        self.assertEqual(self.residue(), ["data volume: still holds link-to-dir"])

    def test_another_slots_files_are_not_this_slots_residue(self):
        self.reset()
        (self.etc / "demo-2-a.env").write_text("another slot's key")
        other_data = self.volumes / "ghost-demo-30003-data" / "_data"
        other_data.mkdir(parents=True)
        (other_data / "ghost.db").write_text("another slot's site")
        self.assertEqual(self.residue(), [])

    def test_the_adapters_volume_is_not_tenant_state(self):
        adapters = self.volumes / "ghost-demo-2-adapters" / "_data"
        adapters.mkdir(parents=True)
        (adapters / "marker").write_text("platform code")
        self.reset()
        self.assertEqual(self.residue(), [])
        self.assertEqual((adapters / "marker").read_text(), "platform code")

    def test_a_volume_that_is_a_link_is_reported_as_nothing_rather_than_followed(self):
        os.rmdir(self.data)
        os.rmdir(self.data.parent)
        os.symlink(self.elsewhere, self.data.parent)
        self.assertEqual(rr.residue_of(SLOT, None), [])


if __name__ == "__main__":
    unittest.main()

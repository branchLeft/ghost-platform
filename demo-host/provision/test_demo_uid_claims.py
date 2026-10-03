#!/usr/bin/env python3
"""Unit tests for demo_uid_claims, against a real temporary directory.

The tenant-side register reader is imported and run over what this module
writes, so the two estates agreeing on the claim format is a test rather
than a comment.
"""

from __future__ import annotations

import importlib.util
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import demo_uid_claims as duc
import render_slot_sudoers as rss

_TENANT_MODULE = Path(__file__).resolve().parents[2] / "app" / "provision" / "provision_tenant_volume.py"
_spec = importlib.util.spec_from_file_location("provision_tenant_volume", _TENANT_MODULE)
ptv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ptv)

ME = os.getuid()


def no_volumes(argv, **_kwargs):
    return SimpleNamespace(returncode=0, stdout="", stderr="")


class _Case(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = os.path.join(self._tmp.name, "tenant-uids")

    def record(self, **kw):
        return duc.record_demo_claims(self.dir, owner_uid=ME, **kw)

    def make_dir(self, mode=0o700):
        os.mkdir(self.dir)
        os.chmod(self.dir, mode)

    def put(self, name, text):
        with open(os.path.join(self.dir, name), "w") as f:
            f.write(text)


class RecordTests(_Case):
    def test_claims_all_seven_slots_with_the_slot_uid(self):
        created = self.record()
        self.assertEqual(created, [f"demo-{n}" for n in range(7)])
        for n in range(7):
            text = Path(self.dir, f"demo-{n}").read_text()
            self.assertEqual(text, f"slug=demo-{n}\nuid={30001 + n}\n")

    def test_files_are_0600_and_directory_is_0700(self):
        self.record()
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)
        for n in range(7):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dir, f"demo-{n}")).st_mode), 0o600)

    def test_rerun_is_a_no_op(self):
        self.record()
        self.assertEqual(self.record(), [])

    def test_rerun_fills_in_only_the_missing_claim(self):
        self.record()
        os.unlink(os.path.join(self.dir, "demo-3"))
        self.assertEqual(self.record(), ["demo-3"])

    def test_slot_table_is_the_sudoers_slot_table(self):
        self.assertEqual(duc.SLOT_NAMES, rss.SLOT_NAMES)
        self.assertEqual([duc.slot_uid(s) for s in rss.SLOT_NAMES], list(range(30001, 30008)))

    def test_no_temp_file_left_behind(self):
        self.record()
        self.assertEqual(sorted(os.listdir(self.dir)), [f"demo-{n}" for n in range(7)])


class RefusalTests(_Case):
    def test_refuses_a_demo_slug_claimed_at_another_uid_and_writes_nothing(self):
        self.make_dir()
        self.put("demo-2", "slug=demo-2\nuid=30500\n")
        with self.assertRaisesRegex(duc.ClaimError, "already claimed at uid 30500"):
            self.record()
        self.assertEqual(os.listdir(self.dir), ["demo-2"])

    def test_refuses_a_slot_uid_held_by_a_tenant(self):
        self.make_dir()
        self.put("blog", "slug=blog\nuid=30003\n")
        with self.assertRaisesRegex(duc.ClaimError, "already claimed by 'blog'"):
            self.record()
        self.assertEqual(os.listdir(self.dir), ["blog"])

    def test_refuses_an_unparseable_claim(self):
        self.make_dir()
        self.put("blog", "garbage")
        with self.assertRaises(duc.ClaimError):
            self.record()

    def test_refuses_a_claim_whose_filename_disagrees_with_its_slug(self):
        self.make_dir()
        self.put("blog", "slug=other\nuid=30900\n")
        with self.assertRaisesRegex(duc.ClaimError, "edited by hand"):
            self.record()

    def test_refuses_a_symlinked_claim(self):
        self.make_dir()
        target = os.path.join(self._tmp.name, "elsewhere")
        Path(target).write_text("slug=blog\nuid=30900\n")
        os.symlink(target, os.path.join(self.dir, "blog"))
        with self.assertRaises(duc.ClaimError):
            self.record()

    def test_refuses_a_group_or_world_accessible_directory(self):
        self.make_dir(0o755)
        with self.assertRaisesRegex(duc.ClaimError, "mode"):
            self.record()
        self.assertEqual(os.listdir(self.dir), [])

    def test_refuses_a_directory_owned_by_someone_else(self):
        self.make_dir()
        with self.assertRaisesRegex(duc.ClaimError, "owned by uid"):
            duc.record_demo_claims(self.dir, owner_uid=ME + 1)

    def test_refuses_a_non_directory(self):
        Path(self.dir).write_text("x")
        with self.assertRaisesRegex(duc.ClaimError, "not a directory"):
            self.record()

    def test_refuses_a_uid_outside_the_tenant_range(self):
        with mock_uid_base(29000):
            with self.assertRaisesRegex(duc.ClaimError, "outside the reserved range"):
                self.record()
        self.assertFalse(os.path.exists(self.dir))


class mock_uid_base:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        self.old = duc.UID_BASE
        duc.UID_BASE = self.value

    def __exit__(self, *exc):
        duc.UID_BASE = self.old


class TenantSideAgreementTests(_Case):
    def test_constants_match_the_tenant_module(self):
        self.assertEqual(duc.CLAIM_DIR, ptv.CLAIM_DIR)
        self.assertEqual(duc.CLAIM_DIR_MODE, ptv.CLAIM_DIR_MODE)
        self.assertEqual(duc.CLAIM_MODE, ptv.CLAIM_MODE)
        self.assertEqual(duc.TENANT_UID_MIN, ptv.TENANT_UID_MIN)
        self.assertEqual(duc.TENANT_UID_MAX, ptv.TENANT_UID_MAX)

    def test_tenant_reader_parses_every_demo_claim(self):
        self.record()
        for n in range(7):
            text = Path(self.dir, f"demo-{n}").read_text()
            self.assertEqual(ptv.parse_claim(text), (f"demo-{n}", 30001 + n))

    def test_tenant_register_sees_the_demo_uids_as_taken(self):
        self.record()
        claims = ptv.existing_claims(run=no_volumes, claim_dir=self.dir)
        self.assertEqual({v for k, v in claims.items() if k.startswith("demo-")}, set(range(30001, 30008)))


class MainTests(_Case):
    def test_exit_zero_and_count(self):
        # main() fixes owner_uid at root, so a non-root test run exercises
        # its refusal path instead; the success path is covered above.
        if ME == 0:
            self.skipTest("running as root")
        self.make_dir()
        self.assertEqual(duc.main(["--claim-dir", self.dir]), 1)

    def test_exit_zero_when_recording_succeeds(self):
        from unittest import mock

        with mock.patch.object(duc, "record_demo_claims", return_value=["demo-0"]) as rec:
            self.assertEqual(duc.main(["--claim-dir", self.dir]), 0)
        rec.assert_called_once_with(self.dir)

    def test_exit_one_on_refusal(self):
        self.make_dir(0o755)
        self.assertEqual(duc.main(["--claim-dir", self.dir]), 1)


if __name__ == "__main__":
    unittest.main()

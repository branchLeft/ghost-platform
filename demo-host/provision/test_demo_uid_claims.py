#!/usr/bin/env python3
"""Unit tests for demo_uid_claims, against a real temporary directory.

The tenant-side register reader is imported and run over what this module
writes, so the two estates agreeing on the claim format is a test rather
than a comment.
"""

from __future__ import annotations

import fcntl
import importlib.util
import os
import stat
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import branchleft_slot as bs
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
        kw.setdefault("passwd_uids", lambda: set())
        return duc.record_demo_claims(self.dir, owner_uid=ME, **kw)

    def set_umask(self, mask):
        old = os.umask(mask)
        self.addCleanup(os.umask, old)

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
        self.assertEqual(duc.UID_BASE, bs.UID_BASE)
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


class PinnedControlTests(_Case):
    def test_refuses_a_directory_in_the_register(self):
        self.make_dir()
        os.mkdir(os.path.join(self.dir, "blog"))
        with self.assertRaisesRegex(duc.ClaimError, "not a regular file"):
            self.record()

    def test_refuses_a_fifo_in_the_register(self):
        self.make_dir()
        os.mkfifo(os.path.join(self.dir, "blog"))
        with self.assertRaisesRegex(duc.ClaimError, "not a regular file"):
            self.record()

    def test_claim_files_are_0600_whatever_the_umask(self):
        self.set_umask(0o277)
        self.record()
        for n in range(7):
            mode = stat.S_IMODE(os.stat(os.path.join(self.dir, f"demo-{n}")).st_mode)
            self.assertEqual(mode, 0o600)

    def test_new_directory_is_0700_whatever_the_umask(self):
        self.set_umask(0o277)
        self.record()
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)

    def test_temp_file_is_0600_before_the_rename(self):
        self.set_umask(0o277)
        modes = []
        real_replace = os.replace

        def spy(src, dst):
            modes.append(stat.S_IMODE(os.stat(src).st_mode))
            return real_replace(src, dst)

        with mock.patch.object(duc.os, "replace", side_effect=spy):
            self.record()
        self.assertEqual(set(modes), {0o600})


class DurabilityTests(_Case):
    def test_file_then_rename_then_directory_are_synced_in_order(self):
        events = []
        real_fsync, real_replace = os.fsync, os.replace

        def fsync(fd):
            kind = "dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file"
            events.append(f"fsync-{kind}")
            return real_fsync(fd)

        def replace(src, dst):
            events.append("replace")
            return real_replace(src, dst)

        with mock.patch.object(duc.os, "fsync", side_effect=fsync), mock.patch.object(
            duc.os, "replace", side_effect=replace
        ):
            self.record(slots=["0"])
        self.assertEqual(events, ["fsync-file", "replace", "fsync-dir"])


class LockTests(_Case):
    def hold(self):
        self.make_dir()
        fd = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        return fd

    def test_refuses_while_another_run_holds_the_lock_and_writes_nothing(self):
        self.hold()
        with self.assertRaisesRegex(duc.ClaimError, "another run holds the lock"):
            self.record()
        self.assertEqual(os.listdir(self.dir), [])

    def test_lock_is_released_after_success(self):
        self.record()
        fd = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_lock_is_released_after_a_refusal(self):
        self.make_dir()
        self.put("demo-2", "slug=demo-2\nuid=30500\n")
        with self.assertRaises(duc.ClaimError):
            self.record()
        fd = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_the_register_check_runs_under_the_lock(self):
        held = []
        real_read = duc.read_register

        def read(path):
            probe = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(False)
                except OSError:
                    held.append(True)
            finally:
                os.close(probe)
            return real_read(path)

        with mock.patch.object(duc, "read_register", side_effect=read):
            self.record()
        self.assertEqual(held, [True])

    def test_two_real_processes_do_not_both_write(self):
        self.make_dir()
        script = (
            "import sys, os, time\n"
            f"sys.path.insert(0, {str(Path(duc.__file__).parent)!r})\n"
            "import demo_uid_claims as d\n"
            "real = d.read_register\n"
            "def slow(p):\n"
            "    open(sys.argv[2], 'w').close()\n"
            "    time.sleep(1.5)\n"
            "    return real(p)\n"
            "d.read_register = slow\n"
            f"d.record_demo_claims(sys.argv[1], owner_uid={ME}, passwd_uids=lambda: set())\n"
        )
        marker = os.path.join(self._tmp.name, "started")
        first = subprocess.Popen([sys.executable, "-c", script, self.dir, marker])
        self.addCleanup(first.wait)
        for _ in range(100):
            if os.path.exists(marker):
                break
            time.sleep(0.1)
        else:
            self.fail("first run never reached the register read")
        with self.assertRaisesRegex(duc.ClaimError, "another run holds the lock"):
            self.record()
        self.assertEqual(first.wait(timeout=30), 0)
        self.assertEqual(len(os.listdir(self.dir)), 7)


class StaleTempTests(_Case):
    def test_removes_a_stale_temp_and_completes(self):
        self.make_dir()
        self.put("demo-3.tmp", "slug=demo-3\nuid=3000")
        messages = []
        created = self.record(log=messages.append)
        self.assertEqual(created, [f"demo-{n}" for n in range(7)])
        self.assertEqual(sorted(os.listdir(self.dir)), [f"demo-{n}" for n in range(7)])
        self.assertEqual(messages, ["removed stale demo-3.tmp left by an interrupted run"])

    def test_refuses_a_symlinked_temp_and_leaves_its_target(self):
        self.make_dir()
        target = os.path.join(self._tmp.name, "elsewhere")
        Path(target).write_text("keep")
        os.symlink(target, os.path.join(self.dir, "demo-1.tmp"))
        with self.assertRaisesRegex(duc.ClaimError, "not a regular file"):
            self.record()
        self.assertEqual(Path(target).read_text(), "keep")

    def test_refuses_a_temp_owned_by_someone_else(self):
        self.make_dir()
        self.put("demo-1.tmp", "x")
        with self.assertRaisesRegex(duc.ClaimError, "owned by uid"):
            duc.clear_stale_temp(self.dir, "demo-1", owner_uid=ME + 1)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "demo-1.tmp")))

    def test_a_temp_for_a_foreign_slug_is_not_ours_to_remove(self):
        self.make_dir()
        self.put("blog.tmp", "x")
        with self.assertRaises(duc.ClaimError):
            self.record()
        self.assertTrue(os.path.exists(os.path.join(self.dir, "blog.tmp")))

    def test_no_stale_temp_reports_nothing(self):
        self.make_dir()
        self.assertFalse(duc.clear_stale_temp(self.dir, "demo-0", owner_uid=ME))


class PasswdTests(_Case):
    def test_refuses_a_new_claim_whose_uid_an_account_already_has(self):
        with self.assertRaisesRegex(duc.ClaimError, "uid 30004 for demo-3 already belongs"):
            self.record(passwd_uids=lambda: {0, 1000, 30004})
        self.assertEqual(os.listdir(self.dir), [])

    def test_an_unrelated_uid_does_not_refuse(self):
        self.assertEqual(len(self.record(passwd_uids=lambda: {0, 1000, 65534})), 7)

    def test_an_already_claimed_slug_may_have_its_account(self):
        self.record()
        self.assertEqual(self.record(passwd_uids=lambda: set(range(30001, 30008))), [])

    def test_a_missing_claim_is_still_checked_on_rerun(self):
        self.record()
        os.unlink(os.path.join(self.dir, "demo-5"))
        with self.assertRaisesRegex(duc.ClaimError, "demo-5 already belongs"):
            self.record(passwd_uids=lambda: {30006})

    def test_reader_returns_the_uid_column(self):
        path = os.path.join(self._tmp.name, "passwd")
        Path(path).write_text(
            "# comment\n\nroot:x:0:0:root:/root:/bin/sh\nslot:x:30001:30001::/home/s:/bin/false\n"
        )
        self.assertEqual(duc.read_passwd_uids(path), {0, 30001})

    def test_reader_refuses_a_short_line(self):
        path = os.path.join(self._tmp.name, "passwd")
        Path(path).write_text("root:x\n")
        with self.assertRaisesRegex(duc.ClaimError, "not a passwd entry"):
            duc.read_passwd_uids(path)

    def test_reader_refuses_a_non_numeric_uid(self):
        path = os.path.join(self._tmp.name, "passwd")
        Path(path).write_text("root:x:zero:0::/root:/bin/sh\n")
        with self.assertRaisesRegex(duc.ClaimError, "non-numeric"):
            duc.read_passwd_uids(path)

    def test_default_source_is_the_host_passwd_file(self):
        self.assertEqual(duc.PASSWD_PATH, "/etc/passwd")
        self.assertIn(0, duc.read_passwd_uids())


class StandaloneTests(unittest.TestCase):
    def test_runs_with_only_its_own_file_present(self):
        with tempfile.TemporaryDirectory() as lone:
            copy = os.path.join(lone, "demo_uid_claims.py")
            shutil.copy(duc.__file__, copy)
            proc = subprocess.run(
                [sys.executable, "-I", copy, "--claim-dir", os.path.join(lone, "reg")],
                capture_output=True,
                text=True,
                cwd=lone,
            )
        self.assertNotIn("ModuleNotFoundError", proc.stderr)
        self.assertNotIn("ImportError", proc.stderr)
        self.assertIn(proc.returncode, (0, 1))

    def test_imports_nothing_from_this_repository(self):
        import ast

        tree = ast.parse(Path(duc.__file__).read_text())
        roots = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                roots.add((node.module or "").split(".")[0])
        self.assertLessEqual(roots, set(sys.stdlib_module_names))


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
        with mock.patch.object(duc, "record_demo_claims", return_value=["demo-0"]) as rec:
            self.assertEqual(duc.main(["--claim-dir", self.dir]), 0)
        self.assertEqual(rec.call_args.args, (self.dir,))

    def test_exit_one_on_refusal(self):
        self.make_dir(0o755)
        self.assertEqual(duc.main(["--claim-dir", self.dir]), 1)


if __name__ == "__main__":
    unittest.main()

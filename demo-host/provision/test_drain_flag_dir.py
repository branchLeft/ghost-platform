#!/usr/bin/env python3
"""Unit tests for drain_flag_dir.

`scripts/test-drain-flag-dir-permissions.sh` is the real-filesystem,
real-uid proof (this test process is not root and cannot chown to an
arbitrary uid, nor easily become a different unprivileged uid to prove a
write is denied) -- these tests cover the logic `chown`/`chmod` calls
happen with the right arguments, and that preseeding is exactly the (slot,
colour) table, idempotent and never destructive to a flag already there.
"""

from __future__ import annotations

import os
import stat
import tempfile
import unittest
from unittest import mock

import drain_flag_dir as dfd
import render_slot_sudoers as rss


class ResolveBrokerIdsTests(unittest.TestCase):
    def test_returns_the_uid_and_gid_of_an_existing_account(self):
        fake_entry = mock.Mock(pw_uid=64200, pw_gid=64200)
        with mock.patch("drain_flag_dir.pwd.getpwnam", return_value=fake_entry) as getpwnam:
            uid, gid = dfd.resolve_broker_ids("broker")
        getpwnam.assert_called_once_with("broker")
        self.assertEqual((uid, gid), (64200, 64200))

    def test_refuses_a_missing_account_rather_than_guessing(self):
        with mock.patch("drain_flag_dir.pwd.getpwnam", side_effect=KeyError("broker")):
            with self.assertRaises(dfd.DrainFlagProvisionError):
                dfd.resolve_broker_ids("broker")


class ProvisionDrainFlagDirTests(unittest.TestCase):
    def test_creates_the_directory_owned_by_the_broker_and_mode_0755(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "drain-flags")
            with mock.patch("drain_flag_dir.os.chown") as chown:
                dfd.provision_drain_flag_dir(target, broker_uid=64200, broker_gid=64200)
            self.assertTrue(os.path.isdir(target))
            chown.assert_called_once_with(target, 64200, 64200)
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o755)

    def test_idempotent_against_a_directory_that_already_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "drain-flags")
            os.makedirs(target)
            with mock.patch("drain_flag_dir.os.chown"):
                dfd.provision_drain_flag_dir(target, broker_uid=1, broker_gid=1)  # must not raise
            self.assertTrue(os.path.isdir(target))

    def test_reasserts_mode_0755_even_if_a_prior_run_left_it_wrong(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "drain-flags")
            os.makedirs(target, mode=0o700)
            os.chmod(target, 0o700)
            with mock.patch("drain_flag_dir.os.chown"):
                dfd.provision_drain_flag_dir(target, broker_uid=1, broker_gid=1)
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o755)


class PreseedDrainFlagsTests(unittest.TestCase):
    def test_creates_one_file_per_slot_and_colour(self):
        with tempfile.TemporaryDirectory() as tmp:
            created = dfd.preseed_drain_flags(tmp)
            self.assertEqual(len(created), len(rss.SLOT_NAMES) * len(rss.COLOURS))
            for slot in rss.SLOT_NAMES:
                for colour in rss.COLOURS:
                    self.assertTrue(
                        os.path.exists(os.path.join(tmp, dfd.flag_file_name(slot, colour)))
                    )

    def test_flag_file_names_match_the_brokers_own_naming(self):
        # services/broker/src/drainFlag.ts's `flagPath`: `${slot}-${colour}.drain`.
        self.assertEqual(dfd.flag_file_name("3", "a"), "3-a.drain")

    def test_created_files_are_empty_and_mode_0644(self):
        with tempfile.TemporaryDirectory() as tmp:
            dfd.preseed_drain_flags(tmp, slots=("0",), colours=("a",))
            path = os.path.join(tmp, "0-a.drain")
            self.assertEqual(os.path.getsize(path), 0)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o644)

    def test_a_second_run_creates_nothing_new(self):
        with tempfile.TemporaryDirectory() as tmp:
            dfd.preseed_drain_flags(tmp)
            second = dfd.preseed_drain_flags(tmp)
            self.assertEqual(second, [])

    def test_never_touches_a_flag_the_broker_has_already_set(self):
        # A flag already SET (broker has written real content into it, or
        # simply created it after a colour started and was later drained)
        # must survive a re-run of host build untouched -- preseeding must
        # never re-clear a colour a re-run of provisioning happens to reach.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "0-a.drain")
            with open(path, "wb") as handle:
                handle.write(b"not empty -- simulates a flag the broker set")
            os.chmod(path, 0o600)  # simulates a mode the broker, not this module, chose

            created = dfd.preseed_drain_flags(tmp, slots=("0",), colours=("a",))

            self.assertEqual(created, [])
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), b"not empty -- simulates a flag the broker set")
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_scales_with_a_smaller_slot_and_colour_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            created = dfd.preseed_drain_flags(tmp, slots=("0", "1"), colours=("a", "b"))
            self.assertEqual(len(created), 4)


class MainTests(unittest.TestCase):
    def test_main_provisions_and_preseeds_end_to_end_with_a_fake_broker_account(self):
        fake_entry = mock.Mock(pw_uid=1, pw_gid=1)
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "drain-flags")
            with mock.patch("drain_flag_dir.pwd.getpwnam", return_value=fake_entry), mock.patch(
                "drain_flag_dir.os.chown"
            ):
                exit_code = dfd.main(["--path", target, "--broker-user", "broker"])
            self.assertEqual(exit_code, 0)
            self.assertEqual(
                len(os.listdir(target)), len(rss.SLOT_NAMES) * len(rss.COLOURS)
            )

    def test_main_refuses_and_exits_non_zero_for_a_missing_broker_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "drain-flags")
            with mock.patch("drain_flag_dir.pwd.getpwnam", side_effect=KeyError("broker")):
                exit_code = dfd.main(["--path", target, "--broker-user", "no-such-user"])
            self.assertEqual(exit_code, 1)
            self.assertFalse(os.path.exists(target))


if __name__ == "__main__":
    unittest.main()

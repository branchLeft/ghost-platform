#!/usr/bin/env python3
"""Tests for who owns what under the demo host's state root.

The broker's account must not be able to rename the health router's
directory: that needs write access to the router's parent, so the parent is
root-owned and the broker owns only its own subdirectory. The modelled tests
read the ownership provisioning asks for (chown is recorded, not run) and
ask what an unprivileged account could do with it; `RealUidTests` does the
same against a real filesystem and a real uid, and runs only as root (the
container proof in scripts/test-demo-router-dir-permissions.sh).
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import demo_sidecar as ds
import health_router as hr
import provision_socket_dirs as psd

GOLDEN = Path(__file__).resolve().parent / "state-dirs.golden.json"
ME = os.getuid()
VIRTUAL_ROOT = ME
BROKER = (ME + 1000, ME + 1000)
ROUTER = (ME + 2000, ME + 2000)


def golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def can_rename_entries_of(directory: str, uid: int, gid: int, owners: dict[str, tuple[int, int]]) -> bool:
    """Whether `uid`/`gid` could rename or remove an entry of `directory`:
    write and search permission on it, by the owner, group or other bits.
    A directory nobody chowned belongs to the virtual root. The account
    is assumed to hold no other group."""
    st = os.lstat(directory)
    owner_uid, owner_gid = owners.get(directory, (VIRTUAL_ROOT, VIRTUAL_ROOT))
    if uid == 0:
        return True
    if uid == owner_uid:
        bits = (st.st_mode >> 6) & 0o7
    elif gid == owner_gid:
        bits = (st.st_mode >> 3) & 0o7
    else:
        bits = st.st_mode & 0o7
    return bool(bits & 0o2) and bool(bits & 0o1)


class GoldenTests(unittest.TestCase):
    def test_the_provisioner_paths_are_the_golden_ones(self):
        g = golden()
        self.assertEqual(psd.STATE_ROOT, g["stateRoot"])
        self.assertEqual(psd.SOCKET_ROOT, g["routerRoot"])
        self.assertEqual(psd.BROKER_SLOTS_DIR, g["brokerSlotsDir"])
        self.assertEqual(psd.BROKER_USER, g["brokerSlotsDirOwner"])
        self.assertEqual(psd.ROOT_MODE, int(g["stateRootMode"], 8))
        self.assertEqual(psd.ROOT_MODE, int(g["routerRootMode"], 8))
        self.assertEqual(psd.ROOT_MODE, int(g["brokerSlotsDirMode"], 8))

    def test_the_router_and_the_sidecar_launcher_use_the_golden_router_root(self):
        self.assertEqual(hr.SOCKET_ROOT, golden()["routerRoot"])
        self.assertEqual(ds.SOCKET_ROOT, golden()["routerRoot"])

    def test_the_router_root_is_a_child_of_the_state_root_and_beside_the_broker_directory(self):
        g = golden()
        self.assertEqual(os.path.dirname(g["routerRoot"]), g["stateRoot"])
        self.assertEqual(os.path.dirname(g["brokerSlotsDir"]), g["stateRoot"])
        self.assertEqual(os.path.dirname(g["brokerSlotsFile"]), g["brokerSlotsDir"])
        self.assertEqual(g["stateRootOwner"], "root")


class ModelledOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix="sd", dir="/tmp")
        os.chmod(self.state, 0o755)
        self.addCleanup(shutil.rmtree, self.state, True)
        self.router_root = os.path.join(self.state, "demo-router")
        self.slots_dir = os.path.join(self.state, "broker-slots")
        self.owners: dict[str, tuple[int, int]] = {}
        real_lstat = os.lstat

        def lstat(path, *args, **kwargs):
            st = real_lstat(path, *args, **kwargs)
            uid, gid = self.owners.get(os.fspath(path), (st.st_uid, st.st_gid))
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, uid, gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime))  # fmt: skip

        patcher = mock.patch.object(psd.os, "lstat", lstat)
        patcher.start()
        self.addCleanup(patcher.stop)

    def chown(self, path, uid, gid):
        self.owners[path] = (uid, gid)

    def provision_everything(self):
        psd.provision(self.router_root, owner=ROUTER, root_owner_uid=VIRTUAL_ROOT, chown=self.chown)
        psd.provision_broker_slots_dir(
            self.slots_dir, broker=BROKER, root_owner_uid=VIRTUAL_ROOT, chown=self.chown
        )

    def broker_can_rename_entries_of(self, directory: str) -> bool:
        return can_rename_entries_of(directory, *BROKER, self.owners)

    def test_the_broker_cannot_rename_the_routers_directory(self):
        self.provision_everything()
        self.assertFalse(self.broker_can_rename_entries_of(self.state), "the router's root can be renamed")
        self.assertFalse(self.broker_can_rename_entries_of(self.router_root), "a slot directory can be renamed")
        for slot in ("0", "6"):
            slot_dir = os.path.join(self.router_root, slot)
            self.assertFalse(self.broker_can_rename_entries_of(slot_dir))
            self.assertFalse(self.broker_can_rename_entries_of(os.path.join(slot_dir, "a")))

    def test_the_broker_can_write_its_own_subdirectory(self):
        self.provision_everything()
        self.assertTrue(self.broker_can_rename_entries_of(self.slots_dir))

    def test_the_model_does_flag_a_state_root_the_broker_owns(self):
        self.provision_everything()
        self.owners[self.state] = BROKER
        self.assertTrue(self.broker_can_rename_entries_of(self.state))

    def test_the_model_does_flag_a_state_root_the_broker_can_write_by_group_or_other(self):
        self.provision_everything()
        for mode in (0o757, 0o777):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.state, mode)
                self.assertTrue(self.broker_can_rename_entries_of(self.state))
        os.chmod(self.state, 0o775)
        self.owners[self.state] = (VIRTUAL_ROOT, BROKER[1])
        self.assertTrue(self.broker_can_rename_entries_of(self.state))

    def test_a_state_root_the_broker_owns_is_refused_by_provisioning(self):
        with self.assertRaises(psd.ProvisionError):
            psd.provision(self.router_root, owner=ROUTER, root_owner_uid=ME + 1, chown=self.chown)
        with self.assertRaises(psd.ProvisionError):
            psd.provision_broker_slots_dir(self.slots_dir, broker=BROKER, root_owner_uid=ME + 1, chown=self.chown)
        self.assertFalse(os.path.exists(self.router_root))
        self.assertFalse(os.path.exists(self.slots_dir))

    def test_a_state_root_others_can_write_is_refused_by_provisioning(self):
        for mode in (0o775, 0o757, 0o777):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.state, mode)
                with self.assertRaises(psd.ProvisionError):
                    psd.provision(self.router_root, owner=ROUTER, root_owner_uid=VIRTUAL_ROOT, chown=self.chown)
                with self.assertRaises(psd.ProvisionError):
                    psd.provision_broker_slots_dir(
                        self.slots_dir, broker=BROKER, root_owner_uid=VIRTUAL_ROOT, chown=self.chown
                    )

    def test_the_broker_slots_directory_is_broker_owned_0755_and_idempotent(self):
        old = os.umask(0o077)
        self.addCleanup(os.umask, old)
        self.assertTrue(
            psd.provision_broker_slots_dir(self.slots_dir, broker=BROKER, root_owner_uid=VIRTUAL_ROOT, chown=self.chown)
        )
        self.assertEqual(self.owners[self.slots_dir], BROKER)
        self.assertEqual(stat.S_IMODE(os.lstat(self.slots_dir).st_mode), 0o755)
        again: list[str] = []
        self.assertFalse(
            psd.provision_broker_slots_dir(
                self.slots_dir, broker=BROKER, root_owner_uid=VIRTUAL_ROOT, chown=lambda path, *_: again.append(path)
            )
        )
        self.assertEqual(again, [])

    def test_a_broker_slots_directory_with_another_owner_is_refused(self):
        os.mkdir(self.slots_dir, 0o755)
        with self.assertRaises(psd.ProvisionError):
            psd.provision_broker_slots_dir(self.slots_dir, broker=(ME + 1, ME + 1), root_owner_uid=VIRTUAL_ROOT, chown=self.chown)

    def test_an_unknown_broker_account_is_refused(self):
        with self.assertRaises(psd.ProvisionError):
            psd.resolve_broker("no-such-account-for-this-test")

    def test_main_reports_a_refusal_and_exits_non_zero(self):
        os.chmod(self.state, 0o777)
        self.assertEqual(psd.main(["--root", self.router_root, "--broker-slots-dir", self.slots_dir]), 1)


@unittest.skipUnless(
    sys.platform == "linux" and os.geteuid() == 0,
    "needs root on Linux to chown and to drop to another uid",
)
class RealUidTests(unittest.TestCase):
    BROKER_UID = 64210
    ROUTER_UID = 30008

    def test_a_process_running_as_the_broker_cannot_rename_the_routers_directory(self):
        state = tempfile.mkdtemp(prefix="rs", dir="/tmp")
        self.addCleanup(shutil.rmtree, state, True)
        os.chmod(state, 0o755)
        router_root = os.path.join(state, "demo-router")
        slots_dir = os.path.join(state, "broker-slots")
        psd.provision(router_root, owner=(self.ROUTER_UID, self.ROUTER_UID), root_owner_uid=0)
        psd.provision_broker_slots_dir(slots_dir, broker=(self.BROKER_UID, self.BROKER_UID), root_owner_uid=0)
        pid = os.fork()
        if pid == 0:
            code = 3
            try:
                os.setgid(self.BROKER_UID)
                os.setuid(self.BROKER_UID)
                with open(os.path.join(slots_dir, "slots.json"), "w") as handle:
                    handle.write("{}")
                try:
                    os.rename(router_root, router_root + ".moved")
                except PermissionError:
                    code = 0
                else:
                    code = 1
            finally:
                os._exit(code)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0, "the broker's uid could rename the router's directory")
        self.assertTrue(os.path.isdir(router_root))


if __name__ == "__main__":
    unittest.main()

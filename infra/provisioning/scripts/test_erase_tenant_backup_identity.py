#!/usr/bin/env python3
"""Tests for erase_tenant_backup_identity.py, run as an ordinary user through
its seams (`euid`, `owner_uid`, `store`) against a fake spare bucket that
keeps noncurrent versions and delete markers. Hosts are set up by the real
`enrol()` (through the enrolment tests' World), so key names, lists and spare
objects are the real ones. No credential and no real bucket is used.
"""

from __future__ import annotations

import ast
import contextlib
import fcntl
import io
import os
import pathlib
import re
import stat
import subprocess
import unittest
from unittest import mock

import enrol_tenant_backup as et
import erase_tenant_backup_identity as eb
import install_backup_worker as ibw
import restore_drill as rd
import shared_objectstorage
import test_enrol_tenant_backup as fixtures

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SECRET_PREFIX = "AGE-SECRET-KEY-"


class VersionedFakeStore(fixtures.FakeSpareStore):
    """The spare bucket with versioning: `objects` are the current versions,
    `old` the noncurrent versions and delete markers, keyed (key, version id)."""

    CURRENT = "current-version"

    def __init__(self, events: list[str]) -> None:
        super().__init__(events)
        self.old: dict[tuple[str, str], str] = {}
        self.list_error: Exception | None = None
        self.versions_error: Exception | None = None
        self.delete_version_error: Exception | None = None
        self.forbid_get = False
        self.forbidden_reads: list[str] = []

    def get(self, key: str) -> bytes:
        if self.forbid_get:
            self.forbidden_reads.append(key)
            raise AssertionError("erasure read a spare")
        return super().get(key)

    def list_keys(self, prefix: str) -> list[str]:
        if self.list_error is not None:
            raise self.list_error
        return sorted(key for key in self.objects if key.startswith(prefix))

    def list_versions(self, prefix: str) -> list[eb.ObjectVersion]:
        if self.versions_error is not None:
            raise self.versions_error
        found = [eb.ObjectVersion(key, self.CURRENT, "version") for key in sorted(self.objects) if key.startswith(prefix)]
        found += [eb.ObjectVersion(key, vid, kind) for (key, vid), kind in sorted(self.old.items()) if key.startswith(prefix)]
        return found

    def delete_version(self, version: eb.ObjectVersion) -> None:
        if self.delete_version_error is not None:
            raise self.delete_version_error
        if version.version_id == self.CURRENT:
            self.objects.pop(version.key, None)
        else:
            self.old.pop((version.key, version.version_id), None)


class EraseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.world = fixtures.World(self)
        self.store = VersionedFakeStore(self.world.events)
        self.world.store = self.store
        self.erase_config = str(self.world.root / "etc" / "erase-tenant-backup.env")
        self.write_erase_config()

    # -- the simulated host ------------------------------------------------

    def write_erase_config(self, *, bucket=None, key_id=None, drop=(), mode=0o600) -> None:
        values = {
            "ERASE_BACKUP_SPARE_BUCKET": bucket or self.world.SPARE_BUCKET,
            "ERASE_BACKUP_SPARE_ENDPOINT": "SPARE_ENDPOINT",
            "ERASE_BACKUP_SPARE_REGION": "SPARE_REGION",
            "ERASE_BACKUP_SPARE_ACCESS_KEY_ID": key_id or "ERASE_KEY_ID",
            "ERASE_BACKUP_SPARE_SECRET_ACCESS_KEY": "ERASE_KEY_SECRET",
        }
        text = "".join(f"{name}={value}\n" for name, value in values.items() if name not in drop)
        pathlib.Path(self.erase_config).write_text(text)
        os.chmod(self.erase_config, mode)

    def enrol(self, *tenants: str) -> None:
        for tenant in tenants:
            self.assertEqual(self.world.enrol(tenant), 0, self.world.stderr)
        self.store.forbid_get = True

    def identity_of(self, tenant: str) -> bytes:
        return (self.world.identity_dir / f"{tenant}.key").read_bytes()

    def matchers_of(self, tenant: str) -> eb.KeyMatchers:
        return eb.key_matchers(self.identity_of(tenant), self.world.listed_recipient(tenant))

    def remaining(self, tenant: str, matchers: eb.KeyMatchers) -> list[str]:
        return eb.find_remaining(tenant=tenant, paths=self.world.paths, store=self.store, matchers=matchers)

    def erase(self, tenant: str = "bravo", **overrides) -> int:
        kwargs = dict(
            tenant=tenant,
            erase_config=self.erase_config,
            paths=self.world.paths,
            euid=0,
            owner_uid=self.world.uid,
            store=self.store,
        )
        kwargs.update(overrides)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = eb.erase(**kwargs)
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        self.assertNotIn(SECRET_PREFIX, self.stdout + self.stderr)
        return code

    def everything(self) -> dict:
        return {**self.world.state(), "old": dict(self.store.old)}

    def plant(self, name: str, data: bytes, mode: int = 0o600) -> pathlib.Path:
        path = self.world.identity_dir / name
        path.write_bytes(data)
        os.chmod(path, mode)
        return path


class PositiveControlTests(EraseCase):
    def test_the_probe_sees_every_copy_of_an_enrolled_tenant_before_erasure(self) -> None:
        self.enrol("bravo")
        found = "\n".join(self.remaining("bravo", self.matchers_of("bravo")))
        self.assertIn("identity directory entry bravo.key", found)
        self.assertIn("spare object spares/bravo.key.age", found)
        self.assertIn("spare version spares/bravo.key.age", found)
        self.assertIn("the tenants file still lists the tenant", found)
        self.assertIn("the recipients file still lists the tenant", found)

    def test_the_probe_sees_a_leftover_identity_temp_file(self) -> None:
        self.enrol("bravo")
        self.plant(".bravo.key.tmp", b"leftover")
        self.assertIn("identity directory entry .bravo.key.tmp", self.remaining("bravo", self.matchers_of("bravo")))


class ErasureTests(EraseCase):
    def test_erases_every_copy_and_the_proof_reads_each_back_gone(self) -> None:
        self.enrol("bravo")
        matchers = self.matchers_of("bravo")
        link = self.world.outside / "second-name-for-the-key"
        os.link(self.world.identity_dir / "bravo.key", link)
        code = self.erase()
        self.assertEqual(code, eb.EXIT_OK, self.stderr)
        self.assertIn("proof green", self.stdout)
        self.assertEqual(self.remaining("bravo", matchers), [])
        self.assertFalse((self.world.identity_dir / "bravo.key").exists())
        self.assertEqual(self.store.objects.keys() & {"spares/bravo.key.age"}, set())
        self.assertEqual(self.world.enrolled_in_lists("bravo"), (False, False))
        # Shredded, not merely unlinked: another name for the same bytes reads zero.
        self.assertEqual(set(link.read_bytes()), {0})

    def test_a_second_run_finds_nothing_and_says_so(self) -> None:
        self.enrol("bravo")
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        before = self.everything()
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertIn("nothing to erase", self.stdout)
        self.assertEqual(self.everything(), before)

    def test_an_enrolled_tenant_with_no_spare_yet_is_erased(self) -> None:
        self.assertEqual(self.erase("alpha"), eb.EXIT_OK, self.stderr)
        self.assertFalse((self.world.identity_dir / "alpha.key").exists())
        self.assertEqual(self.world.enrolled_in_lists("alpha"), (False, False))

    def test_other_tenants_keep_their_identity_spare_and_list_lines(self) -> None:
        self.enrol("bravo", "charlie")
        self.store.objects["spares/bravo-two.key.age"] = b"a lookalike slug's spare"
        self.store.old[("spares/bravo-two.key.age", "v1")] = "version"
        self.store.old[("spares/charlie.key.age", "v1")] = "version"
        charlie_before = self.identity_of("charlie")
        self.assertEqual(self.erase("bravo"), eb.EXIT_OK, self.stderr)
        self.assertEqual(self.identity_of("charlie"), charlie_before)
        self.assertEqual(self.identity_of("alpha"), self.world.alpha_identity)
        self.assertIn("spares/charlie.key.age", self.store.objects)
        self.assertIn("spares/bravo-two.key.age", self.store.objects)
        self.assertIn(("spares/bravo-two.key.age", "v1"), self.store.old)
        self.assertIn(("spares/charlie.key.age", "v1"), self.store.old)
        self.assertEqual(self.world.enrolled_in_lists("charlie"), (True, True))
        self.assertEqual(self.world.enrolled_in_lists("alpha"), (True, True))
        self.assertTrue(self.remaining("charlie", self.matchers_of("charlie")))

    def test_the_lists_keep_their_owner_group_and_mode(self) -> None:
        self.enrol("bravo")
        before = {n: os.stat(getattr(self.world.paths, n)) for n in ("tenants_file", "recipients_file")}
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        for name, old in before.items():
            new = os.stat(getattr(self.world.paths, name))
            self.assertEqual((new.st_uid, new.st_gid, stat.S_IMODE(new.st_mode)), (old.st_uid, old.st_gid, 0o640))


class StrayCopyTests(EraseCase):
    def test_a_planted_second_copy_is_destroyed_with_the_rest(self) -> None:
        self.enrol("bravo", "charlie")
        identity = self.identity_of("bravo")
        self.plant("bravo.key.bak", identity)
        stripped = b"\n".join(line for line in identity.splitlines() if line.startswith(SECRET_PREFIX.encode()))
        self.plant("notes.txt", b"kept for later\n" + stripped + b"\n")
        comment_only = self.plant("public.txt", next(line for line in identity.splitlines() if b"public key" in line) + b"\n")
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        for name in ("bravo.key.bak", "notes.txt", comment_only.name, "bravo.key"):
            self.assertFalse((self.world.identity_dir / name).exists(), name)
        self.assertTrue((self.world.identity_dir / "charlie.key").exists())
        self.assertTrue((self.world.identity_dir / "alpha.key").exists())

    def test_a_leftover_identity_temp_file_is_destroyed_by_name(self) -> None:
        self.enrol("bravo")
        leftover = self.plant(".bravo.key.tmp", b"a half-written file with no key bytes in it")
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertFalse(leftover.exists())

    def test_the_proof_alone_reports_a_copy_planted_after_the_job(self) -> None:
        self.enrol("bravo")
        matchers = self.matchers_of("bravo")
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertEqual(self.remaining("bravo", matchers), [])
        self.plant("restored-from-somewhere.key", self.world.minted[0])
        self.assertEqual(self.remaining("bravo", matchers), ["identity directory entry restored-from-somewhere.key"])

    def test_a_symlink_under_the_tenants_name_is_unlinked_and_never_written_through(self) -> None:
        self.enrol("bravo")
        target = self.world.outside / "elsewhere.key"
        target.write_bytes(b"not ours to touch")
        (self.world.identity_dir / "bravo.key").unlink()
        os.symlink(target, self.world.identity_dir / "bravo.key")
        code = self.erase()
        self.assertEqual(code, eb.EXIT_OK, self.stderr)
        self.assertFalse(os.path.lexists(self.world.identity_dir / "bravo.key"))
        self.assertEqual(target.read_bytes(), b"not ours to touch")

    def test_a_symlink_under_another_name_is_left_alone(self) -> None:
        self.enrol("bravo")
        os.symlink(self.world.outside / "nowhere", self.world.identity_dir / "pointer")
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertTrue(os.path.islink(self.world.identity_dir / "pointer"))


class VersionTests(EraseCase):
    def test_noncurrent_versions_and_delete_markers_are_deleted_and_checked(self) -> None:
        self.enrol("bravo")
        self.store.old[("spares/bravo.key.age", "v1")] = "version"
        self.store.old[("spares/bravo.key.age", "dm1")] = "delete_marker"
        matchers = self.matchers_of("bravo")
        found = "\n".join(self.remaining("bravo", matchers))
        self.assertIn("spare delete marker spares/bravo.key.age (version dm1)", found)
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertEqual(self.store.old, {})
        self.assertEqual(self.store.objects.keys() & {"spares/bravo.key.age"}, set())
        self.assertEqual(self.remaining("bravo", matchers), [])


class FailClosedTests(EraseCase):
    def assert_red(self, expected: str) -> None:
        self.assertEqual(self.code, eb.EXIT_PROOF_RED, self.stderr)
        self.assertIn("ALERT", self.stderr)
        self.assertIn(expected, self.stderr)
        self.assertNotIn("proof green", self.stdout)

    def test_a_failed_spare_listing_is_red_not_gone(self) -> None:
        self.enrol("bravo")
        self.store.list_error = RuntimeError("listing exploded")
        self.code = self.erase()
        self.assert_red("the spare bucket cannot be listed (RuntimeError)")
        self.assertNotIn("listing exploded", self.stderr)

    def test_a_failed_versions_listing_is_red_not_gone(self) -> None:
        self.enrol("bravo")
        self.store.versions_error = shared_objectstorage.ObjectStorageError("no versions endpoint")
        self.code = self.erase()
        self.assert_red("the spare versions cannot be listed (ObjectStorageError)")

    def test_a_failed_version_delete_is_red_and_everything_else_is_still_done(self) -> None:
        self.enrol("bravo")
        self.store.delete_version_error = shared_objectstorage.ObjectStorageError("denied")
        self.code = self.erase()
        self.assert_red("spare version spares/bravo.key.age")
        self.assertFalse((self.world.identity_dir / "bravo.key").exists())
        self.assertEqual(self.world.enrolled_in_lists("bravo"), (False, False))

    def test_a_failed_identity_destroy_is_red_and_the_spare_is_still_deleted(self) -> None:
        self.enrol("bravo")
        with mock.patch.object(rd, "_destroy_file", side_effect=OSError("disk said no")):
            self.code = self.erase()
        self.assert_red("identity directory entry bravo.key")
        self.assertEqual(self.store.objects.keys() & {"spares/bravo.key.age"}, set())

    @unittest.skipIf(os.geteuid() == 0, "root can read a mode 0 file")
    def test_an_unreadable_identity_directory_entry_is_red(self) -> None:
        self.enrol("bravo")
        self.plant("locked.bin", b"x", mode=0)
        self.code = self.erase()
        self.assert_red("identity directory entry locked.bin cannot be read")

    def test_an_oversize_identity_directory_entry_is_red(self) -> None:
        self.enrol("bravo")
        self.plant("huge.bin", b"x" * (eb.MAX_ENTRY_BYTES + 1))
        self.code = self.erase()
        self.assert_red("identity directory entry huge.bin is too large to check")

    def test_a_non_regular_identity_directory_entry_is_red(self) -> None:
        self.enrol("bravo")
        (self.world.identity_dir / "subdir").mkdir()
        self.code = self.erase()
        self.assert_red("identity directory entry subdir is not a regular file")

    def test_an_unparseable_recipients_file_is_red(self) -> None:
        self.enrol("bravo")
        self.world.write_list("recipients_file", self.world.read("recipients_file").decode() + "garbage\n")
        self.code = self.erase()
        self.assert_red("the recipients file cannot be read or parsed")

    @unittest.skipIf(os.geteuid() == 0, "root can read a mode 0 file")
    def test_an_unreadable_tenants_file_is_red(self) -> None:
        self.enrol("bravo")
        os.chmod(self.world.paths.tenants_file, 0)
        self.addCleanup(os.chmod, self.world.paths.tenants_file, 0o640)
        self.code = self.erase()
        self.assert_red("the tenants file cannot be read")

    def test_an_unexpected_failure_after_changes_began_is_red_and_names_only_the_class(self) -> None:
        self.enrol("bravo")
        boom = RuntimeError(f"{SECRET_PREFIX}1QQQQ must never be printed")
        with mock.patch.object(eb, "destroy_copies", side_effect=boom):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_PROOF_RED)
        self.assertIn("RuntimeError", self.stderr)
        self.assertNotIn("must never be printed", self.stderr)

    def test_an_unexpected_failure_before_changes_is_a_refusal_and_changes_nothing(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        with mock.patch.object(eb, "learn_matchers", side_effect=RuntimeError("boom")):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_REFUSED)
        self.assertIn("nothing changed", self.stderr)
        self.assertEqual(self.everything(), before)


class SafetyClassSabotageTests(EraseCase):
    """The tests that go red when the erasure is broken. Each one makes a step
    silently do nothing and requires the proof, not the step, to say so."""

    def test_proof_goes_red_while_the_spare_remains(self) -> None:
        self.enrol("bravo")
        with mock.patch.object(self.store, "delete_version"):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_PROOF_RED, self.stdout)
        self.assertIn("spare object spares/bravo.key.age", self.stderr)
        self.assertIn("spare version spares/bravo.key.age", self.stderr)
        self.assertIn("RED", self.stderr)

    def test_proof_goes_red_while_a_planted_identity_copy_remains(self) -> None:
        self.enrol("bravo")
        self.plant("bravo.key.bak", self.identity_of("bravo"))
        real = eb.destroy_identity_entry

        def skip_the_stray(identity_dir: str, name: str) -> None:
            if name != "bravo.key.bak":
                real(identity_dir, name)

        with mock.patch.object(eb, "destroy_identity_entry", side_effect=skip_the_stray):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_PROOF_RED, self.stdout)
        self.assertIn("identity directory entry bravo.key.bak", self.stderr)
        self.assertEqual(self.store.objects.keys() & {"spares/bravo.key.age"}, set())

    def test_proof_goes_red_while_a_noncurrent_version_remains(self) -> None:
        self.enrol("bravo")
        self.store.old[("spares/bravo.key.age", "v1")] = "version"
        real = self.store.delete_version
        with mock.patch.object(
            self.store, "delete_version", side_effect=lambda v: None if v.version_id == "v1" else real(v)
        ):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_PROOF_RED, self.stdout)
        self.assertIn("spare version spares/bravo.key.age (version v1)", self.stderr)

    def test_proof_goes_red_while_the_identity_file_remains(self) -> None:
        self.enrol("bravo")
        with mock.patch.object(rd, "_destroy_file"):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_PROOF_RED, self.stdout)
        self.assertIn("identity directory entry bravo.key", self.stderr)

    def test_proof_goes_red_while_a_list_line_remains(self) -> None:
        self.enrol("bravo")
        with mock.patch.object(et, "retract_listing", return_value=[]):
            code = self.erase()
        self.assertEqual(code, eb.EXIT_PROOF_RED, self.stdout)
        self.assertIn("the tenants file still lists the tenant", self.stderr)
        self.assertIn("the recipients file still lists the tenant", self.stderr)


class RerunAfterRedTests(EraseCase):
    """A run that ends red must leave what a run again needs to find the strays:
    the tenant's own identity file is the only source of the key bytes."""

    def skip_destroying(self, stray: str):
        real = eb.destroy_identity_entry

        def skip(identity_dir: str, name: str) -> None:
            if name != stray:
                real(identity_dir, name)

        return mock.patch.object(eb, "destroy_identity_entry", side_effect=skip)

    def test_a_stray_that_survives_a_red_run_is_found_and_destroyed_by_the_next(self) -> None:
        self.enrol("bravo")
        stray = self.plant("bravo.key.bak", self.identity_of("bravo"))
        with self.skip_destroying("bravo.key.bak"):
            self.assertEqual(self.erase(), eb.EXIT_PROOF_RED, self.stdout)
        self.assertTrue(stray.exists())
        self.assertTrue((self.world.identity_dir / "bravo.key").exists())
        self.assertIn("identity directory entry bravo.key.bak", self.stderr)
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertNotIn("nothing to erase", self.stdout)
        self.assertIn("proof green", self.stdout)
        self.assertFalse(stray.exists())
        self.assertFalse((self.world.identity_dir / "bravo.key").exists())

    def test_the_strays_are_gone_before_the_tenants_own_file_is_destroyed(self) -> None:
        self.enrol("bravo")
        self.plant("bravo.key.bak", self.identity_of("bravo"))
        order: list[str] = []
        real = eb.destroy_identity_entry

        def record(identity_dir: str, name: str) -> None:
            order.append(name)
            real(identity_dir, name)

        with mock.patch.object(eb, "destroy_identity_entry", side_effect=record):
            self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertEqual(order, ["bravo.key.bak", "bravo.key"])

    def test_an_entry_that_could_not_be_judged_keeps_the_own_file_until_it_can_be(self) -> None:
        self.enrol("bravo")
        huge = self.plant("huge.bin", b"x" * (eb.MAX_ENTRY_BYTES + 1))
        self.assertEqual(self.erase(), eb.EXIT_PROOF_RED, self.stdout)
        self.assertTrue((self.world.identity_dir / "bravo.key").exists())
        huge.unlink()
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertFalse((self.world.identity_dir / "bravo.key").exists())

    def test_a_copy_planted_between_runs_is_found_while_the_own_file_remains(self) -> None:
        self.enrol("bravo")
        first = self.plant("bravo.key.bak", self.identity_of("bravo"))
        with self.skip_destroying("bravo.key.bak"):
            self.assertEqual(self.erase(), eb.EXIT_PROOF_RED, self.stdout)
        second = self.plant("copy-two.txt", b"saved\n" + self.identity_of("bravo"))
        self.assertEqual(self.erase(), eb.EXIT_OK, self.stderr)
        self.assertFalse(first.exists() or second.exists())


class NeverUnwrapTests(EraseCase):
    def test_erasure_runs_with_no_wrapping_key_no_child_process_and_no_spare_read(self) -> None:
        self.enrol("bravo")
        self.world.wrapping_identity_path.unlink()
        with mock.patch.object(subprocess, "run") as run, mock.patch.object(subprocess, "Popen") as popen:
            code = self.erase()
        self.assertEqual(code, eb.EXIT_OK, self.stderr)
        self.assertEqual((run.call_count, popen.call_count), (0, 0))
        self.assertEqual(self.store.forbidden_reads, [])

    def test_the_erase_config_names_no_wrapping_key(self) -> None:
        self.assertFalse([name for name in eb.ERASE_REQUIRED_NAMES if "WRAPPING" in name])
        self.assertNotIn("WRAPPING", pathlib.Path(self.erase_config).read_text().upper())
        example = (REPO_ROOT / "control" / "provision" / "erase-tenant-backup.env.example").read_text()
        self.assertNotIn("WRAPPING", example.upper())

    def test_the_source_has_no_child_process_and_no_decryption(self) -> None:
        source = (HERE / "erase_tenant_backup_identity.py").read_text()
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported |= {alias.name for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        self.assertFalse(imported & {"subprocess", "media_backup_restore", "os.system"})
        for forbidden in ("age -d", '"-d"', "age-keygen", "encrypt_with_age", "get_object", "subprocess"):
            self.assertNotIn(forbidden, source)

    def test_the_real_store_refuses_to_read_or_write_a_spare(self) -> None:
        store = eb.S3EraseStore(eb.EraseConfig("B", "E", "R", "ID", "SECRET"), module=object())
        with self.assertRaises(NotImplementedError):
            store.get("spares/a.key.age")
        with self.assertRaises(NotImplementedError):
            store.put("spares/a.key.age", b"x")


class RefusalTests(EraseCase):
    def assert_refused(self, code: int, expected: str, before: dict) -> None:
        self.assertEqual(code, eb.EXIT_REFUSED, self.stderr)
        self.assertIn(expected, self.stderr)
        self.assertIn("nothing changed", self.stderr)
        self.assertEqual(self.everything(), before)

    def test_not_root(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        self.assert_refused(self.erase(euid=1000), "must run as root", before)

    def test_a_bad_slug(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        for slug in ("Bravo", "../etc", "bravo.key", "", "a b"):
            with self.subTest(slug=slug):
                self.assert_refused(self.erase(slug), "tenant name", before)

    def test_a_missing_erase_config(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        self.assert_refused(self.erase(erase_config=str(self.world.root / "nope.env")), "cannot be read", before)

    def test_an_incomplete_erase_config(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        for name in eb.ERASE_REQUIRED_NAMES:
            with self.subTest(missing=name):
                self.write_erase_config(drop=(name,))
                self.assert_refused(self.erase(), name, before)

    def test_a_loose_mode_erase_config(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        self.write_erase_config(mode=0o644)
        self.assert_refused(self.erase(), "must be mode 0600", before)

    def test_an_erase_config_owned_by_someone_else(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        self.assert_refused(self.erase(owner_uid=self.world.uid + 1), "must be owned by uid", before)

    def test_an_erase_bucket_that_is_a_dump_copy(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        self.write_erase_config(bucket=self.world.DUMP_BUCKET)
        self.assert_refused(self.erase(), "same bucket as the", before)

    def test_an_erase_key_that_is_a_dump_copys_key(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        for key_id in ("WORKER_KEY_ID", "DRILL_KEY_ID"):
            with self.subTest(key_id=key_id):
                self.write_erase_config(key_id=key_id)
                self.assert_refused(self.erase(), "same key as the", before)

    def test_an_identity_directory_that_is_not_private(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        os.chmod(self.world.identity_dir, 0o755)
        self.addCleanup(os.chmod, self.world.identity_dir, 0o700)
        self.assert_refused(self.erase(), "must be mode 0700", before)

    def test_an_enrolment_or_another_erasure_holds_the_lock(self) -> None:
        self.enrol("bravo")
        before = self.everything()
        fd = os.open(self.world.paths.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assert_refused(self.erase(), "another enrolment is running", before)

    def test_main_refuses_a_missing_argument_and_a_non_root_caller(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                eb.main([])
        self.assertEqual(raised.exception.code, eb.EXIT_USAGE)
        with mock.patch.object(os, "geteuid", return_value=1000), contextlib.redirect_stderr(io.StringIO()) as err:
            code = eb.main(["--tenant", "bravo", "--erase-config", "/nonexistent"])
        self.assertEqual(code, eb.EXIT_REFUSED)
        self.assertIn("must run as root", err.getvalue())


class TiesTests(unittest.TestCase):
    def test_the_example_config_names_exactly_the_names_the_entry_point_reads(self) -> None:
        text = (REPO_ROOT / "control" / "provision" / "erase-tenant-backup.env.example").read_text()
        lines = [line for line in text.splitlines() if line and not line.startswith("#")]
        self.assertEqual(sorted(line.split("=", 1)[0] for line in lines), sorted(eb.ERASE_REQUIRED_NAMES))
        self.assertTrue(all(re.fullmatch(r"[A-Z0-9_]+", line.split("=", 1)[1]) for line in lines), lines)

    def _local_imports(self, path: pathlib.Path) -> set[str]:
        found = set()
        for node in ast.walk(ast.parse(path.read_text())):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                top = name.split(".")[0]
                if (HERE / f"{top}.py").is_file():
                    found.add(top)
        return found

    def test_the_release_list_holds_the_script_and_every_module_it_imports(self) -> None:
        self.assertIn("infra/provisioning/scripts/erase_tenant_backup_identity.py", ibw.REQUIRED_RELEASE_FILES)
        pending, seen = ["erase_tenant_backup_identity"], set()
        while pending:
            module = pending.pop()
            if module in seen:
                continue
            seen.add(module)
            pending.extend(self._local_imports(HERE / f"{module}.py"))
        for module in sorted(seen):
            self.assertIn(f"infra/provisioning/scripts/{module}.py", ibw.REQUIRED_RELEASE_FILES, module)

    def test_the_spare_prefix_covers_the_enrolment_key_and_no_other_slug(self) -> None:
        self.assertTrue(et.spare_key_for("bravo").startswith(eb.spare_prefix("bravo")))
        self.assertFalse(et.spare_key_for("bravo-two").startswith(eb.spare_prefix("bravo")))
        self.assertFalse(et.spare_key_for("bravotwo").startswith(eb.spare_prefix("bravo")))

    def test_the_identity_names_are_the_enrolments_own(self) -> None:
        self.assertEqual(rd.IDENTITY_SUFFIX, ".key")
        self.assertEqual(os.path.basename(et.identity_tmp_path("/d", "bravo")), ".bravo.key.tmp")


S3_NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'


def versions_xml(entries, *, truncated=False, next_key=None, next_version=None) -> bytes:
    body = ""
    for tag, key, version_id in entries:
        id_xml = f"<VersionId>{version_id}</VersionId>" if version_id is not None else ""
        body += f"<{tag}><Key>{key}</Key>{id_xml}<IsLatest>true</IsLatest></{tag}>"
    body += f"<IsTruncated>{'true' if truncated else 'false'}</IsTruncated>"
    if next_key:
        body += f"<NextKeyMarker>{next_key}</NextKeyMarker>"
    if next_version:
        body += f"<NextVersionIdMarker>{next_version}</NextVersionIdMarker>"
    return f"<ListVersionsResult {S3_NS}><Name>b</Name>{body}</ListVersionsResult>".encode()


class FakeS3Module:
    ObjectStorageError = shared_objectstorage.ObjectStorageError

    def __init__(self, responses=()) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    def signed_request(self, **kwargs):
        self.calls.append(("signed_request", kwargs))
        return self.responses.pop(0)

    def list_objects(self, **kwargs):
        self.calls.append(("list_objects", kwargs))
        return [{"key": "spares/a.key.age"}]

    def delete_object(self, **kwargs):
        self.calls.append(("delete_object", kwargs))


class S3EraseStoreTests(unittest.TestCase):
    CONFIG = eb.EraseConfig("B", "E", "R", "ID", "SECRET")

    def store(self, *responses):
        module = FakeS3Module(responses)
        return eb.S3EraseStore(self.CONFIG, module=module), module

    def test_it_lists_versions_and_delete_markers_across_pages(self) -> None:
        store, module = self.store(
            (200, versions_xml([("Version", "spares/a.key.age", "v2")], truncated=True, next_key="spares/a.key.age", next_version="v2")),
            (200, versions_xml([("Version", "spares/a.key.age", "v1"), ("DeleteMarker", "spares/a.key.age", "dm")])),
        )
        found = store.list_versions("spares/a.")
        self.assertEqual(
            found,
            [
                eb.ObjectVersion("spares/a.key.age", "v2", "version"),
                eb.ObjectVersion("spares/a.key.age", "v1", "version"),
                eb.ObjectVersion("spares/a.key.age", "dm", "delete_marker"),
            ],
        )
        first, second = (kwargs for _, kwargs in module.calls)
        self.assertEqual(first["query"], {"versions": "", "prefix": "spares/a."})
        self.assertEqual(second["query"]["key-marker"], "spares/a.key.age")
        self.assertEqual(second["query"]["version-id-marker"], "v2")
        self.assertEqual({k: second[k] for k in ("bucket", "endpoint", "region", "access_key", "secret_key")},
                         {"bucket": "B", "endpoint": "E", "region": "R", "access_key": "ID", "secret_key": "SECRET"})

    def test_an_empty_bucket_lists_nothing(self) -> None:
        store, _ = self.store((200, versions_xml([])))
        self.assertEqual(store.list_versions("spares/a."), [])

    def test_a_truncated_listing_with_no_marker_is_an_error_not_a_short_answer(self) -> None:
        store, _ = self.store((200, versions_xml([("Version", "spares/a.key.age", "v1")], truncated=True)))
        with self.assertRaises(shared_objectstorage.ObjectStorageError):
            store.list_versions("spares/a.")

    def test_a_failing_status_and_a_garbled_body_are_errors(self) -> None:
        store, _ = self.store((403, b"<Error><Code>AccessDenied</Code></Error>"))
        with self.assertRaises(shared_objectstorage.ObjectStorageError):
            store.list_versions("spares/a.")
        store, _ = self.store((200, b"<not-xml"))
        with self.assertRaises(Exception):
            store.list_versions("spares/a.")

    def test_an_entry_with_no_key_is_an_error(self) -> None:
        store, _ = self.store((200, f"<ListVersionsResult {S3_NS}><Version><VersionId>v</VersionId></Version></ListVersionsResult>".encode()))
        with self.assertRaises(shared_objectstorage.ObjectStorageError):
            store.list_versions("spares/a.")

    def test_it_deletes_a_version_by_id_and_tolerates_not_found(self) -> None:
        store, module = self.store((204, b""), (404, b""))
        store.delete_version(eb.ObjectVersion("spares/a.key.age", "v1", "version"))
        store.delete_version(eb.ObjectVersion("spares/a.key.age", "v1", "version"))
        for _, kwargs in module.calls:
            self.assertEqual((kwargs["method"], kwargs["key"], kwargs["query"]), ("DELETE", "spares/a.key.age", {"versionId": "v1"}))

    def test_a_refused_version_delete_is_an_error(self) -> None:
        store, _ = self.store((403, b""))
        with self.assertRaises(shared_objectstorage.ObjectStorageError):
            store.delete_version(eb.ObjectVersion("spares/a.key.age", "v1", "version"))

    def test_an_entry_with_no_version_id_is_deleted_as_a_plain_object(self) -> None:
        store, module = self.store()
        store.delete_version(eb.ObjectVersion("spares/a.key.age", "", "version"))
        self.assertEqual([name for name, _ in module.calls], ["delete_object"])

    def test_it_lists_keys_under_a_prefix(self) -> None:
        store, module = self.store()
        self.assertEqual(store.list_keys("spares/a."), ["spares/a.key.age"])
        self.assertEqual(module.calls[0][1]["prefix"], "spares/a.")

    def test_the_credential_never_appears_in_the_config_repr(self) -> None:
        self.assertNotIn("SECRET", repr(self.CONFIG))
        self.assertNotIn("access_key", repr(self.CONFIG))


class MatcherTests(unittest.TestCase):
    def test_matchers_hold_the_secret_line_and_the_public_comment_but_not_other_text(self) -> None:
        identity = b"# created: x\n# public key: age1abc\nAGE-SECRET-KEY-1QQQQ\n"
        matchers = eb.key_matchers(identity, "age1def")
        self.assertTrue(matchers.holds(b"prefix\nAGE-SECRET-KEY-1QQQQ\r\n"))
        self.assertTrue(matchers.holds(b"# public key: age1abc\n"))
        self.assertTrue(matchers.holds(b"# public key: age1def\n"))
        self.assertFalse(matchers.holds(b"AGE-SECRET-KEY-1ZZZZ\n# public key: age1zzz\n"))
        self.assertTrue(eb.key_matchers(None, None).empty)
        self.assertNotIn("QQQQ", repr(matchers))


if __name__ == "__main__":
    unittest.main()

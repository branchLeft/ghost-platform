#!/usr/bin/env python3
"""Tests for enrol_tenant_backup.py, run as an ordinary user through its seams
(`euid`, `owner_uid`, `store`, `keygen`, `runner`, `start_dump`, `dump_reader`)
against real `age` and `age-keygen`, and against the real `run_tenant_dump`
for the dumps that the simulated first-dump unit takes. Every refusal gate has
a test that goes red when the gate is removed; the transcripts are in the pull
request. See test_enrol_tenant_backup.md.
"""

from __future__ import annotations

import ast
import contextlib
import datetime
import fcntl
import hashlib
import io
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import backup_recipients as br
import backup_worker as bw
import enrol_tenant_backup as et
import install_backup_worker as ibw
import nightly_dump_loop as loop
import restore_drill as rd
import test_nightly_dump_loop as dump_fixtures
from dial_in_transport import LocalProcessTransport
from pull_encrypt_store import CopyTarget

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SECRET_PREFIX = "AGE-SECRET-KEY-"


def new_identity() -> tuple[bytes, str]:
    """A fresh age identity file and its recipient."""
    identity = subprocess.run(["age-keygen"], capture_output=True, check=True).stdout
    recipient = subprocess.run(["age-keygen", "-y"], input=identity, capture_output=True, check=True).stdout
    return identity, recipient.decode().strip()


class FakeSpareStore:
    """The spare bucket, as a dict, recording the order things happen in."""

    def __init__(self, events: list[str]) -> None:
        self.objects: dict[str, bytes] = {}
        self.events = events
        self.put_error: Exception | None = None
        self.delete_error: Exception | None = None
        self.corrupt_reads = False

    def put(self, key: str, data: bytes) -> None:
        if self.put_error is not None:
            raise self.put_error
        self.events.append("spare_put")
        self.objects[key] = data

    def get(self, key: str) -> bytes:
        self.events.append("spare_get")
        data = self.objects[key]
        return data + b"x" if self.corrupt_reads else data

    def exists(self, key: str) -> bool:
        return key in self.objects

    def delete(self, key: str) -> None:
        if self.delete_error is not None:
            raise self.delete_error
        self.objects.pop(key, None)


class FakeDumpBucket:
    """The dump copies as a dict of (copy name, key) -> bytes."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}

    def put(self, copy: str, key: str, data: bytes) -> None:
        self.objects[(copy, key)] = data

    def list(self, copy: rd.DrillCopy, prefix: str) -> list[str]:
        return sorted(key for (name, key) in self.objects if name == copy.name and key.startswith(prefix))

    def get(self, copy: rd.DrillCopy, key: str) -> bytes:
        return self.objects[(copy.name, key)]


class RecordingRunner:
    """Stands in for subprocess.run: real age and age-keygen, recorded; a fake
    systemctl whose `start` runs `on_start`, which plays the service account."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict | None]] = []
        self.nightly_state = "inactive"
        self.on_start = None

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs.get("env")))
        if argv[0] == "systemctl":
            if argv[1] == "is-active":
                return subprocess.CompletedProcess(argv, 0, f"{self.nightly_state}\n".encode(), b"")
            if argv[1] == "start":
                returncode = self.on_start(argv[-1]) if self.on_start else 0
                return subprocess.CompletedProcess(argv, returncode, b"", b"")
            raise AssertionError(f"unexpected systemctl call {argv}")
        return subprocess.run(argv, **kwargs)

    def systemctl_calls(self) -> list[list[str]]:
        return [argv for argv, _ in self.calls if argv[0] == "systemctl"]


class World:
    """A temporary host: the root-only files, the lists, the identity
    directory, the stack file, the fake buckets, and tenant `alpha`, already
    enrolled by hand."""

    DUMP_BUCKET = "DUMP_BUCKET"
    SPARE_BUCKET = "SPARE_BUCKET"

    def __init__(self, case: unittest.TestCase) -> None:
        tmp = tempfile.TemporaryDirectory()
        case.addCleanup(tmp.cleanup)
        outside = tempfile.TemporaryDirectory()
        case.addCleanup(outside.cleanup)
        self.root = pathlib.Path(tmp.name).resolve()
        self.outside = pathlib.Path(outside.name).resolve()
        self.uid, self.gid = os.getuid(), os.getgid()
        etc = self.root / "etc"
        etc.mkdir()
        self.identity_dir = self.root / "identities"
        self.identity_dir.mkdir(mode=0o700)
        os.chmod(self.identity_dir, 0o700)
        self.paths = et.Paths(
            spare_config=str(etc / "enrol-tenant-backup.env"),
            worker_env=str(etc / "backup-worker.env"),
            drill_env=str(etc / "restore-drill.env"),
            tenants_file=str(etc / "backup-worker-tenants"),
            recipients_file=str(etc / "backup-worker-recipients"),
            identity_dir=str(self.identity_dir),
            lock_path=str(self.root / "enrol.lock"),
        )
        self.events: list[str] = []
        self.store = FakeSpareStore(self.events)
        self.bucket = FakeDumpBucket()
        self.runner = RecordingRunner()
        self.runner.on_start = self.service_dump
        self.minted: list[bytes] = []
        self.keygen_override = None

        # The wrapping key pair: the private half is held outside the host.
        wrapping_identity, self.wrapping_recipient = new_identity()
        self.wrapping_identity_path = self.outside / "wrapping.key"
        self.wrapping_identity_path.write_bytes(wrapping_identity)

        self.alpha_identity, self.alpha_recipient = new_identity()
        self.write_spare_config()
        self.write_worker_env()
        self.write_drill_env()
        self.write_list("tenants_file", "alpha\n")
        self.write_list("recipients_file", f"alpha {self.alpha_recipient}\n")
        self.write_identity("alpha", self.alpha_identity)

        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        dump_fixtures._write_fake_bin(str(bin_dir), "mysql", dump_fixtures._FAKE_MYSQL)
        dump_fixtures._write_fake_bin(str(bin_dir), "mysqldump", dump_fixtures._happy_mysqldump("any"))
        patch = mock.patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"})
        patch.start()
        case.addCleanup(patch.stop)

    # -- files ------------------------------------------------------------

    def _write_private(self, path: str, text: str) -> None:
        pathlib.Path(path).write_text(text)
        os.chmod(path, 0o600)

    def write_spare_config(self, *, drop: tuple[str, ...] = (), blank: tuple[str, ...] = (), recipient=None, sha=None) -> None:
        recipient = recipient or self.wrapping_recipient
        values = {
            "ENROL_BACKUP_SPARE_BUCKET": self.SPARE_BUCKET,
            "ENROL_BACKUP_SPARE_ENDPOINT": "SPARE_ENDPOINT",
            "ENROL_BACKUP_SPARE_REGION": "SPARE_REGION",
            "ENROL_BACKUP_SPARE_ACCESS_KEY_ID": "SPARE_KEY_ID",
            "ENROL_BACKUP_SPARE_SECRET_ACCESS_KEY": "SPARE_KEY_SECRET",
            "ENROL_BACKUP_SPARE_WRAPPING_RECIPIENT": recipient,
            "ENROL_BACKUP_SPARE_WRAPPING_RECIPIENT_SHA256": sha or hashlib.sha256(recipient.encode()).hexdigest(),
        }
        lines = [f"{name}={'' if name in blank else value}" for name, value in values.items() if name not in drop]
        self._write_private(self.paths.spare_config, "\n".join(lines) + "\n")

    def write_worker_env(self, *, bucket=None, key_id=None) -> None:
        text = (
            "# comment\n"
            f"BACKUP_WORKER_COPY_PRIMARY_BUCKET={bucket or self.DUMP_BUCKET}\n"
            "BACKUP_WORKER_COPY_PRIMARY_ENDPOINT=DUMP_ENDPOINT\n"
            "BACKUP_WORKER_COPY_PRIMARY_REGION=DUMP_REGION\n"
            f"BACKUP_WORKER_COPY_PRIMARY_ACCESS_KEY_ID={key_id or 'WORKER_KEY_ID'}\n"
            "BACKUP_WORKER_COPY_PRIMARY_SECRET_ACCESS_KEY=WORKER_KEY_SECRET\n"
        )
        self._write_private(self.paths.worker_env, text)

    def write_drill_env(self, *, bucket=None, key_id=None, drop: tuple[str, ...] = ()) -> None:
        values = {
            "BACKUP_DRILL_COPY_PRIMARY_BUCKET": bucket or self.DUMP_BUCKET,
            "BACKUP_DRILL_COPY_PRIMARY_ENDPOINT": "DUMP_ENDPOINT",
            "BACKUP_DRILL_COPY_PRIMARY_REGION": "DUMP_REGION",
            "BACKUP_DRILL_COPY_PRIMARY_ACCESS_KEY_ID": key_id or "DRILL_KEY_ID",
            "BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY": "DRILL_KEY_SECRET",
        }
        lines = [f"{name}={value}" for name, value in values.items() if name not in drop]
        self._write_private(self.paths.drill_env, "\n".join(lines) + "\n")

    def write_list(self, attribute: str, text: str, *, mode: int = 0o640) -> None:
        path = getattr(self.paths, attribute)
        pathlib.Path(path).write_text(text)
        os.chmod(path, mode)
        os.chown(path, self.uid, self.gid)

    def write_identity(self, tenant: str, identity: bytes) -> pathlib.Path:
        path = self.identity_dir / f"{tenant}.key"
        path.write_bytes(identity)
        os.chmod(path, 0o600)
        return path

    def write_stack(self, slug_line: str) -> pathlib.Path:
        path = self.root / "Pulumi.stack.yaml"
        path.write_text(slug_line)
        return path

    def read(self, attribute: str) -> bytes:
        return pathlib.Path(getattr(self.paths, attribute)).read_bytes()

    # -- the simulated host -------------------------------------------------

    def keygen(self) -> bytes:
        if self.keygen_override is not None:
            return self.keygen_override()
        identity = subprocess.run(["age-keygen"], capture_output=True, check=True).stdout
        self.minted.append(identity)
        return identity

    def service_dump(self, unit: str) -> int:
        """The first-dump unit: the real run_tenant_dump, as the service account."""
        tenant = unit.split("@", 1)[1].removesuffix(".service")
        recipients = br.load_recipients(self.paths.recipients_file)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        copies = [
            CopyTarget(
                name="primary",
                put=lambda ciphertext: self.bucket.put("primary", f"dumps/{tenant}/{stamp}.sql.age", ciphertext),
            )
        ]
        result = bw.run_tenant_dump(
            tenant=tenant,
            transport=LocalProcessTransport(),
            mysql_pwd="irrelevant-fake-password",
            age_recipient=recipients[tenant],
            copies=copies,
            dump_tenant_path=dump_fixtures._DUMP_TENANT_PATH,
            socket_path=bw.DEFAULT_SOCKET,
        )
        return 0 if result.ok else 1

    def dump_to(self, tenant: str, recipient: str, stamp: str = "20260101T000000Z") -> None:
        """A dump object encrypted to `recipient`, with no real dump behind it."""
        ciphertext = subprocess.run(["age", "-r", recipient], input=b"fixture", capture_output=True, check=True).stdout
        self.bucket.put("primary", f"dumps/{tenant}/{stamp}.sql.age", ciphertext)

    def dump_of(self, tenant: str) -> bytes:
        (data,) = [blob for (_, key), blob in self.bucket.objects.items() if key.startswith(f"dumps/{tenant}/")]
        return data

    def listed_recipient(self, tenant: str) -> str:
        return br.load_recipients(self.paths.recipients_file)[tenant]

    # -- running the entry point -------------------------------------------

    def enrol(self, tenant: str = "bravo", *, slug_line: str | None = None, **overrides) -> int:
        stack = self.write_stack(slug_line if slug_line is not None else f"config:\n  x-infra:slug: {tenant}\n")
        kwargs = dict(
            tenant=tenant,
            tenant_config=str(stack),
            paths=self.paths,
            euid=0,
            owner_uid=self.uid,
            group_gid=lambda: self.gid,
            store=self.store,
            keygen=self.keygen,
            runner=self.runner,
            dump_reader=self.bucket,
        )
        kwargs.update(overrides)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = et.enrol(**kwargs)
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def state(self) -> dict:
        """Everything an enrolment could change, to compare before and after:
        the two lists, the identity directory, the spare store and the dumps."""
        files = {}
        paths = [pathlib.Path(self.paths.tenants_file), pathlib.Path(self.paths.recipients_file)]
        paths += sorted(self.identity_dir.iterdir())
        for path in paths:
            info = path.stat()
            files[str(path)] = (path.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        return {
            "files": files,
            "spare": dict(self.store.objects),
            "dumps": dict(self.bucket.objects),
        }

    def enrolled_in_lists(self, tenant: str) -> tuple[bool, bool]:
        recipients = br.load_recipients(self.paths.recipients_file)
        tenants = et.tenant_names(self.read("tenants_file"))
        return tenant in recipients, tenant in tenants


class WorldCase(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World(self)


class HappyPathTests(WorldCase):
    def test_enrols_a_tenant_and_checks_its_first_dump(self) -> None:
        world = self.world
        code = world.enrol("bravo")
        self.assertEqual(code, 0, world.stderr)
        self.assertEqual(world.enrolled_in_lists("bravo"), (True, True))
        identity = world.identity_dir / "bravo.key"
        self.assertEqual(stat.S_IMODE(identity.stat().st_mode), 0o600)
        self.assertEqual(identity.read_bytes(), world.minted[0])
        self.assertIn("spares/bravo.key.age", world.store.objects)
        self.assertIn("opens with the tenant's own key", world.stdout)
        # The fingerprint of the pinned wrapping recipient is printed on every run.
        self.assertIn(hashlib.sha256(world.wrapping_recipient.encode()).hexdigest(), world.stdout)

    def test_the_spare_decrypts_under_the_wrapping_key_to_the_same_identity(self) -> None:
        world = self.world
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        spare = world.store.objects["spares/bravo.key.age"]
        clear = subprocess.run(
            ["age", "-d", "-i", str(world.wrapping_identity_path)], input=spare, capture_output=True, check=True
        ).stdout
        self.assertEqual(clear, world.minted[0])

    def test_lists_keep_their_owner_group_and_mode(self) -> None:
        world = self.world
        before = {
            name: os.stat(getattr(world.paths, name)) for name in ("tenants_file", "recipients_file")
        }
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        for name, old in before.items():
            new = os.stat(getattr(world.paths, name))
            self.assertEqual((new.st_uid, new.st_gid, stat.S_IMODE(new.st_mode)), (old.st_uid, old.st_gid, 0o640), name)
        leftovers = [p.name for p in (world.root / "etc").iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])
        self.assertEqual([p.name for p in world.identity_dir.iterdir() if p.name.startswith(".")], [])

    def test_main_refuses_a_missing_argument_and_a_non_root_caller(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                et.main([])
        self.assertEqual(raised.exception.code, et.EXIT_USAGE)
        with mock.patch.object(os, "geteuid", return_value=1000), contextlib.redirect_stderr(io.StringIO()) as err:
            code = et.main(["--tenant", "bravo", "--tenant-config", "/nonexistent"])
        self.assertEqual(code, et.EXIT_REFUSED)
        self.assertIn("must run as root", err.getvalue())


class PositiveControlTests(WorldCase):
    def test_each_tenants_dump_opens_with_its_own_identity_and_no_other(self) -> None:
        world = self.world
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        self.assertEqual(world.enrol("charlie"), 0, world.stderr)
        bravo_dump = world.dump_of("bravo")

        def opens(identity_path: pathlib.Path, data: bytes) -> subprocess.CompletedProcess:
            return subprocess.run(["age", "-d", "-i", str(identity_path), "-o", os.devnull], input=data, capture_output=True)

        self.assertEqual(opens(world.identity_dir / "bravo.key", bravo_dump).returncode, 0)
        other = opens(world.identity_dir / "charlie.key", bravo_dump)
        self.assertNotEqual(other.returncode, 0)
        self.assertIn(rd.NO_IDENTITY_MATCHED, other.stderr.decode())
        self.assertIn(rd.NO_IDENTITY_MATCHED, opens(world.identity_dir / "alpha.key", bravo_dump).stderr.decode())
        # One recipient on the dump, and it is not the spare's wrapping key.
        rd.check_single_recipient(bravo_dump, "bravo dump")
        wrapping = opens(world.wrapping_identity_path, bravo_dump)
        self.assertIn(rd.NO_IDENTITY_MATCHED, wrapping.stderr.decode())


class DuplicateRecipientTests(WorldCase):
    def test_duplicate_recipient_refused_and_nothing_remains(self) -> None:
        world = self.world
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        bravo_identity = world.minted[0]
        world.keygen_override = lambda: bravo_identity  # the generator returns the same recipient twice
        lists_before = (world.read("recipients_file"), world.read("tenants_file"))
        spare_before = dict(world.store.objects)
        writes: list[str] = []
        real_replace = et.replace_atomically

        def record(path, data, like):
            writes.append(os.path.basename(path))
            return real_replace(path, data, like)

        with mock.patch.object(et, "replace_atomically", side_effect=record):
            code = world.enrol("charlie")
        self.assertEqual(code, et.EXIT_REFUSED, world.stderr)
        self.assertIn("share one recipient", world.stderr)
        # The bad text was never written to either list, not even briefly.
        self.assertEqual(writes, [])
        self.assertEqual((world.read("recipients_file"), world.read("tenants_file")), lists_before)
        self.assertFalse((world.identity_dir / "charlie.key").exists())
        self.assertEqual(world.store.objects, spare_before)
        self.assertEqual([p.name for p in world.identity_dir.iterdir() if p.name.startswith(".")], [])


class OrderTests(WorldCase):
    def _record_events(self):
        world = self.world
        real_replace, real_identity = et.replace_atomically, et.write_identity_file

        def replace(path, data, like):
            result = real_replace(path, data, like)
            world.events.append("recipients_written" if path == world.paths.recipients_file else "tenants_written")
            return result

        def identity(*args, **kwargs):
            result = real_identity(*args, **kwargs)
            world.events.append("identity_written")
            return result

        return mock.patch.object(et, "replace_atomically", side_effect=replace), mock.patch.object(
            et, "write_identity_file", side_effect=identity
        )

    def test_recipient_listed_only_after_both_copies_read_back(self) -> None:
        world = self.world
        replace_patch, identity_patch = self._record_events()
        with replace_patch, identity_patch:
            self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        self.assertEqual(
            world.events,
            ["spare_put", "spare_get", "identity_written", "recipients_written", "tenants_written"],
        )

    def _assert_nothing_remains(self, before: dict) -> None:
        self.assertEqual(self.world.state(), before)

    def test_failure_at_each_step_leaves_nothing(self) -> None:
        world = self.world
        real_replace = et.replace_atomically
        real_link = os.link

        def failing_tenants_write(path, data, like):
            # Fails the write that adds the tenant, not the rollback that removes it.
            if path == world.paths.tenants_file and b"bravo" in data:
                raise OSError("simulated failure writing the tenants file")
            return real_replace(path, data, like)

        real_problems = et.list_file_problems
        calls = {"n": 0}

        def failing_readback(*args, **kwargs):
            calls["n"] += 1
            return ["simulated read-back problem"] if calls["n"] == 2 else real_problems(*args, **kwargs)

        cases = {
            "spare put": lambda: mock.patch.object(world.store, "put_error", RuntimeError("down")),
            "spare read-back": lambda: mock.patch.object(world.store, "corrupt_reads", True),
            "identity file": lambda: mock.patch.object(et.os, "link", side_effect=OSError("simulated link failure")),
            "tenants list": lambda: mock.patch.object(et, "replace_atomically", side_effect=failing_tenants_write),
            "list read-back": lambda: mock.patch.object(et, "list_file_problems", side_effect=failing_readback),
        }
        for step, patcher in cases.items():
            with self.subTest(step=step):
                calls["n"] = 0
                before = world.state()
                with patcher():
                    code = world.enrol("bravo")
                self.assertEqual(code, et.EXIT_REFUSED, world.stderr)
                self._assert_nothing_remains(before)
                self.assertEqual(world.enrolled_in_lists("bravo"), (False, False))
        self.assertIs(os.link, real_link)

    def test_rollback_that_cannot_complete_exits_six_and_names_the_leftover(self) -> None:
        world = self.world
        world.store.delete_error = RuntimeError("delete refused")
        with mock.patch.object(et.os, "link", side_effect=OSError("simulated link failure")):
            code = world.enrol("bravo")
        self.assertEqual(code, et.EXIT_ROLLBACK_INCOMPLETE)
        self.assertIn("ALERT", world.stderr)
        self.assertIn("spares/bravo.key.age", world.stderr)


class NothingIsPrintedOrStoredInClearTests(WorldCase):
    def _all_text_of_the_run(self) -> list[str]:
        texts = [self.world.stdout, self.world.stderr]
        for argv, env in self.world.runner.calls:
            texts.extend(argv)
            texts.extend((env or {}).values())
        return texts

    def test_private_half_nowhere_but_the_identity_file(self) -> None:
        world = self.world
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        secret = re.search(rb"AGE-SECRET-KEY-1[A-Z0-9]+", world.minted[0]).group(0)
        for text in self._all_text_of_the_run():
            self.assertNotIn(SECRET_PREFIX, text)
        holders = []
        for path in world.root.rglob("*"):
            if path.is_file() and secret in path.read_bytes():
                holders.append(path)
        self.assertEqual(holders, [world.identity_dir / "bravo.key"])
        for blob in [*world.store.objects.values(), *world.bucket.objects.values()]:
            self.assertNotIn(secret, blob)
        spare = world.store.objects["spares/bravo.key.age"]
        self.assertTrue(spare.startswith(b"age-encryption.org/v1\n"))
        self.assertEqual(et.mbr.count_age_recipient_stanzas(spare), 1)

    def test_a_failure_prints_the_exception_class_never_its_text(self) -> None:
        world = self.world
        world.store.put_error = RuntimeError(f"text that must not be shown {SECRET_PREFIX}")
        code = world.enrol("bravo")
        self.assertEqual(code, et.EXIT_REFUSED)
        self.assertIn("RuntimeError", world.stderr)
        self.assertNotIn("must not be shown", world.stderr + world.stdout)
        self.assertNotIn(SECRET_PREFIX, world.stderr + world.stdout)


class NoRootCreatedRunStateTests(WorldCase):
    def test_entry_point_creates_nothing_under_run_lock_or_state_dirs(self) -> None:
        world = self.world
        run_dir = world.root / "run-lock-dir"
        metrics_dir = world.root / "metrics"

        def unit_without_a_dump(unit: str) -> int:
            world.dump_to("bravo", world.listed_recipient("bravo"))
            return 0

        world.runner.on_start = unit_without_a_dump
        environment = {
            "NIGHTLY_DUMP_LOOP_RUN_LOCK_PATH": str(run_dir / "nightly-dump-loop.lock"),
            "BACKUP_WORKER_METRICS_DIR": str(metrics_dir),
        }
        with mock.patch.dict(os.environ, environment), mock.patch.object(
            bw, "run_tenant_dump"
        ) as dump, mock.patch.object(loop, "_RunLock") as run_lock, mock.patch.object(
            bw, "record_backup_age_metric"
        ) as age_metric, mock.patch.object(bw, "record_dump_lock_metrics") as lock_metrics:
            code = world.enrol("bravo")
        self.assertEqual(code, 0, world.stderr)
        self.assertFalse(run_dir.exists())
        self.assertFalse(metrics_dir.exists())
        self.assertEqual(
            world.runner.systemctl_calls(),
            [
                ["systemctl", "is-active", et.NIGHTLY_UNIT],
                ["systemctl", "start", "--wait", "branchleft-backup-worker-first-dump@bravo.service"],
            ],
        )
        for mocked in (dump, run_lock, age_metric, lock_metrics):
            mocked.assert_not_called()


class WrongKeyTests(WorldCase):
    def test_stored_dump_encrypted_to_the_wrong_recipient_exits_four_and_retracts(self) -> None:
        world = self.world
        _, stranger = new_identity()

        def unit(unit_name: str) -> int:
            world.dump_to("bravo", stranger)
            return 0

        world.runner.on_start = unit
        code = world.enrol("bravo")
        self.assertEqual(code, et.EXIT_WRONG_KEY, world.stderr)
        self.assertIn("ALERT", world.stderr)
        self.assertIn("dumps/bravo/", world.stderr)
        # Both lines are retracted, both key copies are kept.
        self.assertEqual(world.enrolled_in_lists("bravo"), (False, False))
        self.assertTrue((world.identity_dir / "bravo.key").exists())
        self.assertIn("spares/bravo.key.age", world.store.objects)
        # A re-run is a half-enrolled refusal, not a false "already enrolled".
        self.assertEqual(world.enrol("bravo"), et.EXIT_HALF_ENROLLED)

    def test_another_identity_in_the_directory_that_opens_the_dump_exits_four(self) -> None:
        world = self.world

        def unit(unit_name: str) -> int:
            world.dump_to("bravo", world.listed_recipient("bravo"))
            # A copy of the tenant's key under another name opens it too.
            (world.identity_dir / "copy.key").write_bytes((world.identity_dir / "bravo.key").read_bytes())
            os.chmod(world.identity_dir / "copy.key", 0o600)
            return 0

        world.runner.on_start = unit
        code = world.enrol("bravo")
        self.assertEqual(code, et.EXIT_WRONG_KEY, world.stderr)
        self.assertIn("copy", world.stderr)
        self.assertEqual(world.enrolled_in_lists("bravo"), (False, False))

    def test_a_dump_with_two_recipients_exits_four(self) -> None:
        world = self.world

        def unit(unit_name: str) -> int:
            recipient = world.listed_recipient("bravo")
            ciphertext = subprocess.run(
                ["age", "-r", recipient, "-r", world.wrapping_recipient], input=b"x", capture_output=True, check=True
            ).stdout
            world.bucket.put("primary", "dumps/bravo/20260101T000000Z.sql.age", ciphertext)
            return 0

        world.runner.on_start = unit
        self.assertEqual(world.enrol("bravo"), et.EXIT_WRONG_KEY, world.stderr)


class FirstDumpFailureTests(WorldCase):
    def _assert_still_enrolled(self) -> None:
        self.assertEqual(self.world.enrolled_in_lists("bravo"), (True, True))
        self.assertTrue((self.world.identity_dir / "bravo.key").exists())

    def test_unit_failure_exits_five_with_an_alert_and_stays_enrolled(self) -> None:
        world = self.world
        world.runner.on_start = lambda unit: 1
        self.assertEqual(world.enrol("bravo"), et.EXIT_FIRST_DUMP)
        self.assertIn("ALERT", world.stderr)
        self._assert_still_enrolled()

    def test_no_new_object_exits_five(self) -> None:
        world = self.world
        world.runner.on_start = lambda unit: 0
        self.assertEqual(world.enrol("bravo"), et.EXIT_FIRST_DUMP)
        self.assertIn("no new dump appeared", world.stderr)
        self._assert_still_enrolled()

    def test_an_old_object_is_not_a_new_one(self) -> None:
        world = self.world
        world.dump_to("bravo", world.alpha_recipient, stamp="20250101T000000Z")
        world.runner.on_start = lambda unit: 0
        self.assertEqual(world.enrol("bravo"), et.EXIT_FIRST_DUMP)

    def test_nightly_active_defers_the_first_dump(self) -> None:
        world = self.world
        world.runner.nightly_state = "activating"
        self.assertEqual(world.enrol("bravo"), et.EXIT_FIRST_DUMP)
        self.assertIn("deferred", world.stderr)
        self.assertNotIn("start", [argv[1] for argv in world.runner.systemctl_calls()])
        self._assert_still_enrolled()

    def test_a_timed_out_unit_exits_five(self) -> None:
        world = self.world

        def hang(unit: str) -> int:
            raise subprocess.TimeoutExpired(["systemctl"], 1)

        world.runner.on_start = hang
        self.assertEqual(world.enrol("bravo"), et.EXIT_FIRST_DUMP)
        self.assertIn("timed out", world.stderr)
        self._assert_still_enrolled()


class RefusalGateTests(WorldCase):
    def _assert_refused_and_unchanged(self, code: int, expected_text: str | None = None, *, exit_code: int = 1) -> None:
        self.assertEqual(code, exit_code, self.world.stderr)
        if expected_text is not None:
            self.assertIn(expected_text, self.world.stderr)

    def test_spare_config_absent_or_incomplete_is_refused(self) -> None:
        world = self.world
        before = world.state()
        os.unlink(world.paths.spare_config)
        with self.subTest(case="absent"):
            self._assert_refused_and_unchanged(world.enrol("bravo"), "spare configuration")
        for name in et.SPARE_REQUIRED_NAMES:
            for how in ("drop", "blank"):
                with self.subTest(name=name, how=how):
                    world.write_spare_config(**{how: (name,)})
                    self._assert_refused_and_unchanged(world.enrol("bravo"), f"does not set {name}")
        with self.subTest(case="wrong mode"):
            world.write_spare_config()
            os.chmod(world.paths.spare_config, 0o640)
            self._assert_refused_and_unchanged(world.enrol("bravo"), "0600")
        with self.subTest(case="drill copy incomplete"):
            world.write_spare_config()
            world.write_drill_env(drop=("BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY",))
            self._assert_refused_and_unchanged(world.enrol("bravo"), "SECRET_ACCESS_KEY")
        # Every refusal above left the lists, the identity directory and both buckets as they were.
        self.assertEqual(world.state(), before)

    def test_spare_that_is_a_dump_copy_is_refused(self) -> None:
        world = self.world
        cases = {
            "worker bucket": lambda: world.write_worker_env(bucket=world.SPARE_BUCKET),
            "worker key id": lambda: world.write_worker_env(key_id="SPARE_KEY_ID"),
            "drill bucket": lambda: world.write_drill_env(bucket=world.SPARE_BUCKET),
            "drill key id": lambda: world.write_drill_env(key_id="SPARE_KEY_ID"),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                world.write_worker_env()
                world.write_drill_env()
                change()
                before = world.state()
                self._assert_refused_and_unchanged(world.enrol("bravo"), "dump copy")
                self.assertEqual(world.state(), before)

    def test_invalid_wrapping_recipient_is_refused(self) -> None:
        world = self.world
        _, other_valid = new_identity()
        cases = {
            "not age": dict(recipient="notanagerecipient"),
            "a tenant's own recipient": dict(recipient=world.alpha_recipient),
            "pin mismatch": dict(recipient=other_valid, sha=hashlib.sha256(b"something else").hexdigest()),
        }
        for name, kwargs in cases.items():
            with self.subTest(case=name):
                world.write_spare_config(**kwargs)
                before = world.state()
                self._assert_refused_and_unchanged(world.enrol("bravo"))
                self.assertEqual(world.state(), before)
        with self.subTest(case="the fingerprint is printed even on a mismatch"):
            self.assertIn(hashlib.sha256(other_valid.encode()).hexdigest(), world.stdout)

    def test_identity_directory_wrong_owner_or_mode_is_refused(self) -> None:
        world = self.world
        with self.assertRaisesRegex(et.Refusal, "owned by uid"):
            et.check_identity_dir(str(world.identity_dir), owner_uid=world.uid + 1)
        et.check_identity_dir(str(world.identity_dir), owner_uid=world.uid)
        os.chmod(world.identity_dir, 0o755)
        before = world.state()
        self._assert_refused_and_unchanged(world.enrol("bravo"), "0700")
        self.assertEqual(world.state(), before)

    def test_not_root_is_refused(self) -> None:
        world = self.world
        before = world.state()
        self._assert_refused_and_unchanged(world.enrol("bravo", euid=1000), "must run as root")
        self.assertEqual(world.state(), before)

    def test_a_second_concurrent_enrolment_is_refused(self) -> None:
        world = self.world
        handle = open(world.paths.lock_path, "a+")
        self.addCleanup(handle.close)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = world.state()
        self._assert_refused_and_unchanged(world.enrol("bravo"), "another enrolment is running")
        self.assertEqual(world.state(), before)

    def test_missing_list_files_are_refused(self) -> None:
        world = self.world
        os.unlink(world.paths.tenants_file)
        self._assert_refused_and_unchanged(world.enrol("bravo"), "tenants file")

    def test_slug_must_match_the_tenants_own_configuration(self) -> None:
        world = self.world
        cases = {
            "different slug": "config:\n  x-infra:slug: other\n",
            "no slug line": "config:\n  x-infra:region: eu\n",
            "two slug lines": "config:\n  x-infra:slug: bravo\n  y-infra:slug: bravo\n",
            "slug fails the shared pattern": "config:\n  x-infra:slug: Bravo_1\n",
        }
        for name, text in cases.items():
            with self.subTest(case=name):
                before = world.state()
                self._assert_refused_and_unchanged(world.enrol("bravo", slug_line=text))
                self.assertEqual(world.state(), before)
        with self.subTest(case="the argument fails the shared pattern too"):
            self._assert_refused_and_unchanged(world.enrol("Bravo_1", slug_line="config:\n  x-infra:slug: Bravo_1\n"))
        with self.subTest(case="a matching configuration proceeds"):
            self.assertEqual(world.enrol("bravo"), 0, world.stderr)


class StateTests(WorldCase):
    def test_already_enrolled_changes_nothing_and_mints_no_second_key(self) -> None:
        world = self.world
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        before = world.state()
        minted = len(world.minted)
        self.assertEqual(world.enrol("bravo"), 0, world.stderr)
        self.assertIn("already enrolled", world.stdout)
        self.assertEqual(len(world.minted), minted)
        self.assertEqual(world.state(), before)

    def test_each_half_enrolled_shape_is_refused_with_exit_three_and_overwrites_nothing(self) -> None:
        world = self.world
        recipient = "age1" + "q" * 58
        shapes = {
            "identity only": lambda: world.write_identity("bravo", b"identity-bytes"),
            "identity temp only": lambda: (world.identity_dir / ".bravo.key.tmp").write_bytes(b"leftover"),
            "spare only": lambda: world.store.objects.update({"spares/bravo.key.age": b"spare-bytes"}),
            "recipient only": lambda: world.write_list(
                "recipients_file", world.read("recipients_file").decode() + f"bravo {recipient}\n"
            ),
            "tenant only": lambda: world.write_list("tenants_file", world.read("tenants_file").decode() + "bravo\n"),
        }
        for name, make in shapes.items():
            with self.subTest(shape=name):
                self.setUp()
                world = self.world
                make()
                before = world.state()
                code = world.enrol("bravo")
                self.assertEqual(code, et.EXIT_HALF_ENROLLED, world.stderr)
                self.assertEqual(world.minted, [])
                self.assertEqual(world.state(), before)
                self.assertIn("half enrolled", world.stderr)


class TiesTests(unittest.TestCase):
    def test_the_example_config_names_exactly_the_names_the_entry_point_reads(self) -> None:
        text = (REPO_ROOT / "control" / "provision" / "enrol-tenant-backup.env.example").read_text()
        names = [line.split("=", 1)[0] for line in text.splitlines() if line and not line.startswith("#")]
        self.assertEqual(sorted(names), sorted(et.SPARE_REQUIRED_NAMES))
        values = [line.split("=", 1)[1] for line in text.splitlines() if line and not line.startswith("#")]
        self.assertTrue(all(re.fullmatch(r"[A-Z0-9_]+", value) for value in values), values)

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

    def test_the_release_list_holds_every_module_the_entry_point_imports(self) -> None:
        pending, seen = ["enrol_tenant_backup"], set()
        while pending:
            module = pending.pop()
            if module in seen:
                continue
            seen.add(module)
            pending.extend(self._local_imports(HERE / f"{module}.py"))
        for module in sorted(seen):
            self.assertIn(f"infra/provisioning/scripts/{module}.py", ibw.REQUIRED_RELEASE_FILES, module)
        for rel in ("db/recovery/restore_drained.py", "control/provision/install_backup_worker.py"):
            self.assertIn(rel, ibw.REQUIRED_RELEASE_FILES)

    def test_the_first_dump_unit_name_matches_the_template_in_the_installer(self) -> None:
        self.assertEqual(et.FIRST_DUMP_UNIT.format(tenant="x"), ibw.FIRST_DUMP_UNIT_TEMPLATE.replace("@.", "@x."))
        self.assertEqual(et.NIGHTLY_UNIT, ibw.SERVICE_UNIT)


class S3SpareStoreTests(unittest.TestCase):
    def test_it_maps_each_operation_onto_the_shared_object_storage_calls(self) -> None:
        calls = []

        class FakeS3:
            def put_object(self, **kwargs):
                calls.append(("put", kwargs))

            def get_object(self, **kwargs):
                calls.append(("get", kwargs))
                return b"bytes"

            def list_objects(self, **kwargs):
                calls.append(("list", kwargs))
                return [{"key": "spares/a.key.age"}, {"key": "spares/a.key.age.other"}]

            def delete_object(self, **kwargs):
                calls.append(("delete", kwargs))

        config = et.SpareConfig("B", "E", "R", "ID", "SECRET", "age1x", "00")
        store = et.S3SpareStore(config, module=FakeS3())
        store.put("spares/a.key.age", b"data")
        self.assertEqual(store.get("spares/a.key.age"), b"bytes")
        self.assertTrue(store.exists("spares/a.key.age"))
        self.assertFalse(store.exists("spares/b.key.age"))
        store.delete("spares/a.key.age")
        self.assertEqual([name for name, _ in calls], ["put", "get", "list", "list", "delete"])
        for _, kwargs in calls:
            self.assertEqual(
                {k: kwargs[k] for k in ("bucket", "endpoint", "region", "access_key", "secret_key")},
                {"bucket": "B", "endpoint": "E", "region": "R", "access_key": "ID", "secret_key": "SECRET"},
            )
        self.assertNotIn("SECRET", repr(config))


if __name__ == "__main__":
    unittest.main()

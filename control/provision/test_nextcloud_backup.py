"""Tests for nextcloud_backup.py: faked docker, plus a Docker proof on synthetic
rows run only with NEXTCLOUD_BACKUP_DOCKER_PROOF=1. See test_nextcloud_backup.md.
"""

from __future__ import annotations

import datetime
import fcntl
import gzip
import io
import json
import os
import pathlib
import secrets
import subprocess
import tarfile
import tempfile
import unittest
from collections import namedtuple
from unittest import mock

import nextcloud_backup as nb

ROW_SECRET = "SYNTHETIC-ROW-TEXT-THAT-MUST-NEVER-BE-PRINTED"
IMAGE_ID = "sha256:" + "a" * 64
Usage = namedtuple("Usage", "total used free")


def done(stdout: str = "", returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr=stderr)


def make_app_tar(path: pathlib.Path, *, with_config: bool = True, extra_files: int = 2) -> int:
    """Writes a synthetic app-volume archive shaped like `tar czf - -C /volume .`
    and returns its entry count."""
    names = ["./", "./config/", "./data/"]
    files = [f"./data/file{i}.txt" for i in range(extra_files)]
    if with_config:
        files.append("./config/config.php")
    with tarfile.open(path, "w:gz") as archive:
        for name in names:
            info = tarfile.TarInfo(name.rstrip("/") or ".")
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        for name in files:
            body = b"synthetic\n"
            info = tarfile.TarInfo(name)
            info.size = len(body)
            archive.addfile(info, io.BytesIO(body))
    return len(names) + len(files)


class FakeDocker:
    """Answers the docker argv this module builds, and records each call."""

    def __init__(self, *, live=("3|7",), restored="3|7", restored_code=0, ps="dbcontainer\n",
                 volumes="nextcloud1_nextcloud-app\n", entries=6, ready_after=0):
        self.calls: list[list[str]] = []
        self.live = list(live)
        self.restored = restored
        self.restored_code = restored_code
        self.ps = ps
        self.volumes = volumes
        self.entries = entries
        self.ready_after = ready_after
        self.app_tar_source: pathlib.Path | None = None

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        sub = argv[1]
        if sub == "ps":
            return done(self.ps)
        if sub == "volume":
            return done(self.volumes)
        if sub == "inspect":
            return done(IMAGE_ID + "\n")
        if sub == "rm":
            return done()
        if sub == "run" and "-d" in argv:
            return done("cid\n")
        if sub == "run" and "du" in argv:
            return done("2048\t/volume\n")
        if sub == "run":
            dest = pathlib.Path(argv[argv.index("-v", argv.index("-v") + 1) + 1].split(":")[0])
            make_app_tar(dest / nb.APP_FILE)
            return done(f"{self.entries}\n")
        if sub == "exec" and "pg_isready" in argv:
            if self.ready_after > 0:
                self.ready_after -= 1
                return done(returncode=2)
            return done()
        if sub == "exec" and any("pg_database_size" in arg for arg in argv):
            return done("1048576\n")
        if sub == "exec" and "127.0.0.1" in argv:
            return done(self.restored, self.restored_code, stderr=ROW_SECRET)
        if sub == "exec":
            value = self.live.pop(0) if len(self.live) > 1 else self.live[0]
            return done(value + "\n")
        raise AssertionError(f"unexpected docker call {argv}")


class FakeProc:
    def __init__(self, *, stdout: bytes = b"", code: int = 0):
        self.stdout = io.BytesIO(stdout)
        self.stdin = io.BytesIO()
        self.code = code
        self.killed = False

    def wait(self):
        return self.code

    def kill(self):
        self.killed = True


def fake_popen(code=0, stdout=b"CREATE TABLE oc_calendars();\n"):
    procs = []

    def popen(argv, **kwargs):
        proc = FakeProc(stdout=stdout, code=code)
        procs.append((argv, proc))
        return proc

    popen.procs = procs
    return popen


def plenty(_path):
    return Usage(100 << 30, 0, 50 << 30)


NOW = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)


class CountsTest(unittest.TestCase):
    def test_parses_two_integers(self):
        self.assertEqual(nb.parse_counts("3|7\n"), nb.Counts(3, 7))

    def test_refuses_anything_else_without_echoing_it(self):
        for out in ("", "3|7\n4|8\n", f"{ROW_SECRET}\n", "3|x\n"):
            with self.subTest(out=out), self.assertRaises(nb.CheckFailed) as ctx:
                nb.parse_counts(out)
            self.assertNotIn(ROW_SECRET, str(ctx.exception))

    def test_equal_counts_pass(self):
        nb.compare_counts(nb.Counts(3, 7), nb.Counts(3, 7))

    def test_a_mismatch_fails_on_either_count(self):
        for restored in (nb.Counts(2, 7), nb.Counts(3, 6), nb.Counts(0, 0)):
            with self.subTest(restored=restored), self.assertRaisesRegex(nb.CheckFailed, "count mismatch"):
                nb.compare_counts(nb.Counts(3, 7), restored)

    def test_zero_live_calendars_is_refused_even_when_equal(self):
        with self.assertRaisesRegex(nb.CheckFailed, "0 calendars"):
            nb.compare_counts(nb.Counts(0, 0), nb.Counts(0, 0))

    def test_count_sql_names_only_counts(self):
        sql = nb.Stack().count_sql()
        self.assertEqual(sql.count("count(*)"), 2)
        self.assertIn("oc_calendars", sql)
        self.assertIn("oc_calendarobjects", sql)

    def test_a_table_prefix_that_is_not_an_identifier_is_refused(self):
        for prefix in ("oc_; DROP", "", "OC_", "a" * 17):
            with self.subTest(prefix=prefix), self.assertRaises(nb.Precondition):
                nb.Stack(table_prefix=prefix).count_sql()


class DockerLookupTest(unittest.TestCase):
    def test_exactly_one_db_container(self):
        for ps in ("", "a\nb\n"):
            with self.subTest(ps=ps), self.assertRaises(nb.Precondition):
                nb.find_db_container(FakeDocker(ps=ps), nb.Stack())
        self.assertEqual(nb.find_db_container(FakeDocker(), nb.Stack()), "dbcontainer")

    def test_db_container_is_found_by_compose_labels(self):
        fake = FakeDocker()
        nb.find_db_container(fake, nb.Stack(project="p"))
        self.assertIn("label=com.docker.compose.project=p", fake.calls[0])
        self.assertIn("label=com.docker.compose.service=db", fake.calls[0])

    def test_exactly_one_app_volume(self):
        def unlabelled(found):
            def runner(argv, **kwargs):
                if argv[1:3] == ["volume", "inspect"]:
                    return done(returncode=0 if found else 1)
                return done("")
            return runner

        with self.assertRaises(nb.Precondition):
            nb.find_app_volume(unlabelled(False), nb.Stack())
        with self.assertRaises(nb.Precondition):
            nb.find_app_volume(FakeDocker(volumes="a\nb\n"), nb.Stack())
        self.assertEqual(nb.find_app_volume(unlabelled(True), nb.Stack()), "nextcloud1_nextcloud-app")
        self.assertEqual(nb.find_app_volume(FakeDocker(), nb.Stack()), "nextcloud1_nextcloud-app")

    def test_image_must_be_a_digest(self):
        with self.assertRaises(nb.Precondition):
            nb.container_image(lambda argv, **k: done("postgres:16\n"), "c")

    def test_a_failing_docker_call_withholds_its_output(self):
        def runner(argv, **kwargs):
            return done(ROW_SECRET, 1, stderr=ROW_SECRET)

        with self.assertRaises(nb.CheckFailed) as ctx:
            nb.live_counts(runner, nb.Stack(), "c")
        self.assertNotIn(ROW_SECRET, str(ctx.exception))

    def test_volume_is_only_ever_mounted_read_only(self):
        fake = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp:
            nb.archive_volume(fake, IMAGE_ID, "vol", pathlib.Path(tmp))
            nb.volume_kib(fake, IMAGE_ID, "vol")
        for call in fake.calls:
            self.assertIn("vol:/volume:ro", call)
            self.assertEqual(call[call.index("--network") + 1], "none")


class FreeSpaceTest(unittest.TestCase):
    def test_refuses_when_headroom_would_be_lost(self):
        usage = lambda _p: Usage(10 << 30, 0, nb.HEADROOM_BYTES + 100)  # noqa: E731
        with self.assertRaisesRegex(nb.Precondition, "free space"):
            nb.require_free_space(pathlib.Path("/"), 101, usage=usage)

    def test_passes_with_room(self):
        nb.require_free_space(pathlib.Path("/"), 1 << 20, usage=plenty)


class LockTest(unittest.TestCase):
    def test_refuses_while_a_deploy_holds_the_stack_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "nextcloud1.deploy.lock"
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                with self.assertRaisesRegex(nb.Precondition, "deploy of nextcloud1 is running"):
                    with nb.deploy_lock(pathlib.Path(tmp), "nextcloud1"):
                        self.fail("entered while the lock was held")
            finally:
                os.close(fd)

    def test_takes_the_lock_when_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            with nb.deploy_lock(pathlib.Path(tmp), "nextcloud1"):
                fd = os.open(pathlib.Path(tmp) / "nextcloud1.deploy.lock", os.O_RDWR)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.close(fd)


class TakeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / "backups"
        self.said: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def _take(self, fake, popen=None):
        return nb.take(stack=nb.Stack(), root=self.root, runner=fake, popen=popen or fake_popen(),
                       usage=plenty, now=NOW, say=self.said.append)

    def test_writes_dump_archive_and_manifest_root_only(self):
        dest = self._take(FakeDocker())
        self.assertEqual(dest.name, "20260102T030405Z")
        self.assertEqual(oct(self.root.stat().st_mode & 0o777), "0o700")
        self.assertEqual(oct(dest.stat().st_mode & 0o777), "0o700")
        manifest = json.loads((dest / nb.MANIFEST_FILE).read_text())
        self.assertEqual(oct((dest / nb.MANIFEST_FILE).stat().st_mode & 0o777), "0o600")
        self.assertEqual(manifest["counts"], {"calendars": 3, "calendar_objects": 7})
        self.assertEqual(manifest["app_entries"], 6)
        self.assertEqual(manifest["image"], IMAGE_ID)
        self.assertEqual(manifest["sha256"][nb.DB_FILE], nb.sha256_file(dest / nb.DB_FILE))
        with gzip.open(dest / nb.DB_FILE) as handle:
            self.assertIn(b"oc_calendars", handle.read())
        self.assertEqual(len(self.said), 1)

    def test_dump_is_taken_without_owners_or_grants(self):
        popen = fake_popen()
        self._take(FakeDocker(), popen)
        argv = popen.procs[0][0]
        self.assertIn("--no-owner", argv)
        self.assertIn("--no-acl", argv)

    def test_counts_moving_during_the_dump_fail_and_leave_nothing(self):
        with self.assertRaisesRegex(nb.CheckFailed, "changed while the dump ran"):
            self._take(FakeDocker(live=("3|7", "3|8")))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_a_failed_dump_leaves_nothing(self):
        with self.assertRaisesRegex(nb.CheckFailed, "pg_dump failed"):
            self._take(FakeDocker(), fake_popen(code=1))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_too_little_space_takes_nothing(self):
        tight = lambda _p: Usage(10 << 30, 0, nb.HEADROOM_BYTES)  # noqa: E731
        with self.assertRaises(nb.Precondition):
            nb.take(stack=nb.Stack(), root=self.root, runner=FakeDocker(), popen=fake_popen(), usage=tight, now=NOW)
        self.assertEqual(list(self.root.iterdir()), [])


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.backup = nb.take(stack=nb.Stack(), root=self.root, runner=FakeDocker(), popen=fake_popen(),
                              usage=plenty, now=NOW, say=lambda _m: None)
        self.said: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def _verify(self, fake, popen=None):
        return nb.verify(self.backup, runner=fake, popen=popen or fake_popen(), sleep=lambda _s: None,
                         say=self.said.append)

    def _rewrite_manifest(self, **changes):
        path = self.backup / nb.MANIFEST_FILE
        manifest = json.loads(path.read_text())
        manifest.update(changes)
        path.write_text(json.dumps(manifest))

    def test_equal_counts_verify(self):
        fake = FakeDocker()
        self.assertEqual(self._verify(fake), nb.Counts(3, 7))
        self.assertIn(["docker", "rm", "-f", "-v", fake.calls[-1][-1]], fake.calls)
        self.assertIn("live and restored equal", self.said[-1])

    def test_the_throwaway_has_no_network_no_logs_and_a_memory_cap(self):
        fake = FakeDocker()
        self._verify(fake)
        run = next(c for c in fake.calls if c[1] == "run" and "-d" in c)
        self.assertEqual(run[run.index("--network") + 1], "none")
        self.assertEqual(run[run.index("--log-driver") + 1], "none")
        self.assertIn("--memory", run)
        self.assertIn("--rm", run)
        self.assertEqual(run[-1], IMAGE_ID)
        self.assertIn("POSTGRES_PASSWORD", run)
        self.assertFalse(any(arg.startswith("POSTGRES_PASSWORD=") for arg in run))

    def test_a_restored_count_mismatch_fails(self):
        with self.assertRaisesRegex(nb.CheckFailed, "count mismatch"):
            self._verify(FakeDocker(restored="3|6"))

    def test_an_empty_restored_database_fails_and_the_throwaway_is_removed(self):
        fake = FakeDocker(restored="", restored_code=1)
        with self.assertRaises(nb.CheckFailed) as ctx:
            self._verify(fake)
        self.assertIn("no countable calendar tables", str(ctx.exception))
        self.assertNotIn(ROW_SECRET, str(ctx.exception))
        self.assertTrue(any(c[:4] == ["docker", "rm", "-f", "-v"] for c in fake.calls))

    def test_a_load_error_fails(self):
        with self.assertRaisesRegex(nb.CheckFailed, "restore load stopped"):
            self._verify(FakeDocker(), fake_popen(code=3))

    def test_a_tampered_file_fails_before_any_container_starts(self):
        with gzip.open(self.backup / nb.DB_FILE, "ab") as handle:
            handle.write(b"--")
        fake = FakeDocker()
        with self.assertRaisesRegex(nb.CheckFailed, "does not match the digest"):
            self._verify(fake)
        self.assertEqual(fake.calls, [])

    def test_a_missing_file_fails(self):
        (self.backup / nb.APP_FILE).unlink()
        with self.assertRaisesRegex(nb.CheckFailed, "is missing"):
            self._verify(FakeDocker())

    def test_a_manifest_recording_zero_calendars_fails(self):
        self._rewrite_manifest(counts={"calendars": 0, "calendar_objects": 0})
        with self.assertRaisesRegex(nb.CheckFailed, "0 calendars"):
            self._verify(FakeDocker(restored="0|0"))

    def test_a_manifest_without_counts_fails(self):
        self._rewrite_manifest(counts={})
        with self.assertRaisesRegex(nb.CheckFailed, "does not record the live counts"):
            self._verify(FakeDocker())

    def test_a_missing_or_bad_manifest_fails(self):
        (self.backup / nb.MANIFEST_FILE).write_text("{")
        with self.assertRaisesRegex(nb.CheckFailed, "not valid JSON"):
            self._verify(FakeDocker())
        (self.backup / nb.MANIFEST_FILE).write_text('{"version": 9}')
        with self.assertRaisesRegex(nb.CheckFailed, "version"):
            self._verify(FakeDocker())
        (self.backup / nb.MANIFEST_FILE).unlink()
        with self.assertRaisesRegex(nb.CheckFailed, "no manifest"):
            self._verify(FakeDocker())

    def test_a_throwaway_that_never_becomes_ready_fails(self):
        fake = FakeDocker(ready_after=10_000)
        target = nb.Throwaway(fake, IMAGE_ID, name="t")
        ticks = iter(range(0, 1000))
        with self.assertRaisesRegex(nb.CheckFailed, "not ready"):
            target.wait_ready(timeout=5, sleep=lambda _s: None, clock=lambda: next(ticks))

    def test_a_dump_that_does_not_decompress_fails(self):
        (self.backup / nb.DB_FILE).write_bytes(gzip.compress(b"x" * 100)[:-10])
        target = nb.Throwaway(FakeDocker(), IMAGE_ID, name="t")
        with self.assertRaisesRegex(nb.CheckFailed, "does not decompress"):
            target.load(self.backup / nb.DB_FILE, popen=fake_popen())


class AppArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name) / nb.APP_FILE

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_whole_archive_with_the_needed_paths_passes(self):
        nb.check_app_archive(self.path, make_app_tar(self.path))

    def test_an_entry_count_mismatch_fails(self):
        entries = make_app_tar(self.path)
        with self.assertRaisesRegex(nb.CheckFailed, "entry mismatch"):
            nb.check_app_archive(self.path, entries + 1)

    def test_missing_config_fails_without_naming_paths(self):
        entries = make_app_tar(self.path, with_config=False)
        with self.assertRaisesRegex(nb.CheckFailed, "lacks 1 of the paths"):
            nb.check_app_archive(self.path, entries)

    def test_a_truncated_archive_fails(self):
        entries = make_app_tar(self.path, extra_files=50)
        data = self.path.read_bytes()
        self.path.write_bytes(data[: len(data) // 2])
        with self.assertRaisesRegex(nb.CheckFailed, "does not read to the end"):
            nb.check_app_archive(self.path, entries)


class SealTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.backup = self.root / "20260102T030405Z"
        self.backup.mkdir()
        (self.backup / nb.MANIFEST_FILE).write_text("{}")
        self.recipients = self.root / "recipient"
        self.recipients.write_text("age1synthetic\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_refuses_without_age_or_recipient_or_a_backup(self):
        with self.assertRaisesRegex(nb.Precondition, "age is not installed"):
            nb.seal(self.backup, self.recipients, which=lambda _n: None)
        with self.assertRaisesRegex(nb.Precondition, "does not exist"):
            nb.seal(self.backup, self.root / "nope", which=lambda _n: "/usr/bin/age")
        with self.assertRaisesRegex(nb.Precondition, "not a backup"):
            nb.seal(self.root, self.recipients, which=lambda _n: "/usr/bin/age")

    def test_writes_the_sealed_file_and_its_digest(self):
        popen = fake_popen()
        out = nb.seal(self.backup, self.recipients, popen=popen, which=lambda _n: "/usr/bin/age", say=lambda _m: None)
        self.assertEqual(out.name, "20260102T030405Z.tar.age")
        self.assertEqual(oct(out.stat().st_mode & 0o777), "0o600")
        digest = (self.root / "20260102T030405Z.tar.age.sha256").read_text().split()[0]
        self.assertEqual(digest, nb.sha256_file(out))
        self.assertEqual(popen.procs[1][0], ["age", "-R", str(self.recipients)])
        with self.assertRaisesRegex(nb.Precondition, "already exists"):
            nb.seal(self.backup, self.recipients, popen=popen, which=lambda _n: "/usr/bin/age")

    def test_a_failed_encryption_leaves_no_sealed_file(self):
        with self.assertRaisesRegex(nb.CheckFailed, "sealing failed"):
            nb.seal(self.backup, self.recipients, popen=fake_popen(code=1), which=lambda _n: "/usr/bin/age")
        self.assertFalse((self.root / "20260102T030405Z.tar.age").exists())


class PruneTest(unittest.TestCase):
    def test_keeps_the_newest_and_the_protected_and_ignores_strangers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            names = [f"2026010{i}T000000Z" for i in range(1, 6)]
            for name in names:
                (root / name).mkdir()
                (root / f"{name}.tar.age").write_text("x")
                (root / f"{name}.tar.age.sha256").write_text("x")
            (root / "keep-me").mkdir()
            removed = nb.prune(root, 2, protect=root / names[0], say=lambda _m: None)
            self.assertEqual(sorted(p.name for p in removed), names[1:3])
            left = sorted(p.name for p in root.iterdir())
            self.assertIn("keep-me", left)
            self.assertIn(names[0], left)
            self.assertNotIn(f"{names[1]}.tar.age", left)

    def test_keep_below_one_is_refused(self):
        with self.assertRaises(nb.Precondition):
            nb.prune(pathlib.Path("/"), 0, protect=pathlib.Path("/"))


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.args = ["--backup-root", self.tmp.name, "--lock-dir", self.tmp.name]
        self.said: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def test_exit_codes(self):
        cases = ((None, 0, "OK"), (nb.CheckFailed("x"), 1, "FAIL: x"), (nb.Precondition("y"), 2, "NOT RUN: y"))
        for effect, code, last in cases:
            with self.subTest(code=code), mock.patch.object(nb, "take", side_effect=effect), \
                    mock.patch.object(nb, "verify"), mock.patch.object(nb, "prune"):
                self.assertEqual(nb.main(["run", *self.args], say=self.said.append), code)
                self.assertEqual(self.said[-1], last)

    def test_run_takes_verifies_then_prunes_in_order(self):
        order = []
        with mock.patch.object(nb, "take", side_effect=lambda **k: order.append("take") or pathlib.Path("t")), \
                mock.patch.object(nb, "verify", side_effect=lambda *a, **k: order.append("verify")), \
                mock.patch.object(nb, "prune", side_effect=lambda *a, **k: order.append("prune")):
            self.assertEqual(nb.main(["run", *self.args], say=self.said.append), 0)
        self.assertEqual(order, ["take", "verify", "prune"])

    def test_a_failed_verify_prunes_nothing(self):
        with mock.patch.object(nb, "take", return_value=pathlib.Path("t")), \
                mock.patch.object(nb, "verify", side_effect=nb.CheckFailed("m")), \
                mock.patch.object(nb, "prune") as prune:
            self.assertEqual(nb.main(["run", *self.args], say=self.said.append), 1)
        prune.assert_not_called()

    def test_take_alone_does_not_verify(self):
        with mock.patch.object(nb, "take", return_value=pathlib.Path("t")), mock.patch.object(nb, "verify") as v:
            self.assertEqual(nb.main(["take", *self.args], say=self.said.append), 0)
        v.assert_not_called()

    def test_verify_and_seal_dispatch(self):
        with mock.patch.object(nb, "verify", side_effect=nb.CheckFailed("m")):
            self.assertEqual(nb.main(["verify", "/x"], say=self.said.append), 1)
        with mock.patch.object(nb, "seal", side_effect=nb.Precondition("p")):
            self.assertEqual(nb.main(["seal", "/x", "--recipient-file", "/r"], say=self.said.append), 2)

    def test_a_bad_table_prefix_is_refused_before_anything_runs(self):
        with mock.patch.object(nb, "take") as take:
            self.assertEqual(nb.main(["take", *self.args, "--table-prefix", "x;"], say=self.said.append), 2)
        take.assert_not_called()


PROOF = os.environ.get("NEXTCLOUD_BACKUP_DOCKER_PROOF") == "1"
PROOF_IMAGE = os.environ.get(
    "NEXTCLOUD_BACKUP_PROOF_IMAGE",
    "docker.io/library/postgres:16-alpine@sha256:3c5c8892d184f738f4fe282d14ddaa613a38f00f4189d2d94725ebe6f2909ddb",
)
PROOF_LABEL = ("--label", "branchleft.agent=nextcloud-backup-proof")
SYNTHETIC_SQL = """
CREATE TABLE oc_calendars (id serial PRIMARY KEY, displayname text);
CREATE TABLE oc_calendarobjects (id serial PRIMARY KEY, calendarid int, calendardata text);
INSERT INTO oc_calendars (displayname) SELECT 'synthetic-' || g FROM generate_series(1, 3) g;
INSERT INTO oc_calendarobjects (calendarid, calendardata) SELECT 1, 'synthetic' FROM generate_series(1, 7);
"""


@unittest.skipUnless(PROOF, "set NEXTCLOUD_BACKUP_DOCKER_PROOF=1 to run the Docker proof")
class DockerProofTest(unittest.TestCase):
    """A synthetic stack under compose labels, backed up and restored for real."""

    @classmethod
    def setUpClass(cls):
        cls.project = "ncproof" + secrets.token_hex(3)
        labels = ["--label", f"com.docker.compose.project={cls.project}", *PROOF_LABEL]
        cls.volume = f"{cls.project}_nextcloud-app"
        cls.db = f"{cls.project}-db"
        cls.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("NEXTCLOUD_BACKUP_PROOF_TMP"))
        cls.addClassCleanup(cls._cleanup)
        cls._docker("volume", "create", *labels, "--label", "com.docker.compose.volume=nextcloud-app", cls.volume)
        cls._docker("run", "--rm", *PROOF_LABEL, "--network", "none", "-v", f"{cls.volume}:/v", "--entrypoint", "sh",
                    PROOF_IMAGE, "-c", "mkdir -p /v/config /v/data/u && echo x > /v/config/config.php"
                    " && echo y > /v/data/u/f.txt")
        cls._docker("run", "-d", "--name", cls.db, *labels, "--label", "com.docker.compose.service=db",
                    "--memory", "256m", "-e", "POSTGRES_PASSWORD=synthetic", "-e", "POSTGRES_USER=nextcloud",
                    "-e", "POSTGRES_DB=nextcloud", PROOF_IMAGE)
        nb.Throwaway(nb._run, PROOF_IMAGE, name=cls.db).wait_ready()
        load = subprocess.run(["docker", "exec", "-i", cls.db, "psql", "-q", "-h", "127.0.0.1", "-U", "nextcloud",
                               "-d", "nextcloud", "-v", "ON_ERROR_STOP=1"], input=SYNTHETIC_SQL, text=True,
                              capture_output=True, check=False)
        assert load.returncode == 0, load.stderr

    @classmethod
    def _docker(cls, *argv):
        result = subprocess.run(["docker", *argv], capture_output=True, text=True, check=False)
        assert result.returncode == 0, result.stderr
        return result.stdout

    @classmethod
    def _cleanup(cls):
        subprocess.run(["docker", "rm", "-f", "-v", cls.db], capture_output=True, check=False)
        subprocess.run(["docker", "volume", "rm", cls.volume], capture_output=True, check=False)
        cls.tmp.cleanup()

    def setUp(self):
        root = pathlib.Path(self.tmp.name) / secrets.token_hex(3)
        self.backup = nb.take(stack=nb.Stack(project=self.project), root=root, say=lambda _m: None)

    def tearDown(self):
        left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={nb.LABEL}"], capture_output=True,
                              text=True, check=False).stdout.split()
        self.assertEqual(left, [], "a throwaway container was left behind")

    def _rewrite(self, **changes):
        path = self.backup / nb.MANIFEST_FILE
        manifest = json.loads(path.read_text())
        manifest.update(changes)
        path.write_text(json.dumps(manifest))

    def test_a_real_backup_restores_with_equal_counts(self):
        manifest = json.loads((self.backup / nb.MANIFEST_FILE).read_text())
        self.assertEqual(manifest["counts"], {"calendars": 3, "calendar_objects": 7})
        self.assertEqual(nb.verify(self.backup, say=lambda _m: None), nb.Counts(3, 7))

    def test_control_case_an_empty_database_fails(self):
        (self.backup / nb.DB_FILE).write_bytes(gzip.compress(b""))
        self._rewrite(sha256={nb.DB_FILE: nb.sha256_file(self.backup / nb.DB_FILE),
                              nb.APP_FILE: nb.sha256_file(self.backup / nb.APP_FILE)})
        self.assertEqual(nb.main(["verify", str(self.backup)], say=lambda _m: None), nb.EXIT_CHECK_FAILED)

    def test_a_count_mismatch_exits_non_zero(self):
        self._rewrite(counts={"calendars": 3, "calendar_objects": 8})
        self.assertEqual(nb.main(["verify", str(self.backup)], say=lambda _m: None), nb.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    unittest.main()

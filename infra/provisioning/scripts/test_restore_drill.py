#!/usr/bin/env python3
"""Unit tests for restore_drill.py. Every docker call is faked except the
`age` and `age-keygen` ones, which FakeDocker runs against the real local
`age` binary with each bind mount mapped back to its host path, so the
recipient check and the erasure proof are exercised on real ciphertext.
The real-container proof is prove-restore-drill.sh."""

from __future__ import annotations

import contextlib
import dataclasses
import datetime
import io
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import backup_manifest as bm
import restore_drill as rd

HAVE_AGE = shutil.which("age") is not None and shutil.which("age-keygen") is not None
DIGEST = "@sha256:" + "a" * 64
NOW = datetime.datetime(2026, 10, 4, 4, 20, tzinfo=datetime.timezone.utc)


def _completed(argv, code=0, out="", err=""):
    return subprocess.CompletedProcess(argv, code, out, err)


def _env(**overrides):
    env = {
        "BACKUP_DRILL_COPY_PRIMARY_BUCKET": "b1",
        "BACKUP_DRILL_COPY_PRIMARY_ENDPOINT": "fsn1.example",
        "BACKUP_DRILL_COPY_PRIMARY_REGION": "fsn1",
        "BACKUP_DRILL_COPY_PRIMARY_ACCESS_KEY_ID": "AK",
        "BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY": "SK",
        "BACKUP_DRILL_RECOVERY_IMAGE": "ghcr.io/x/recovery" + DIGEST,
        "BACKUP_DRILL_MYSQL_IMAGE": "mysql:8.0" + DIGEST,
        "BACKUP_DRILL_GHOST_IMAGE": "ghcr.io/x/ghost" + DIGEST,
        "BACKUP_DRILL_SIDECAR_IMAGE": "ghcr.io/x/sidecar" + DIGEST,
    }
    env.update(overrides)
    return {k: v for k, v in env.items() if v is not None}


def _keygen(directory: pathlib.Path, name: str) -> tuple[pathlib.Path, str]:
    path = directory / f"{name}.key"
    subprocess.run(["age-keygen", "-o", str(path)], check=True, capture_output=True)
    recipient = next(
        line.split(": ", 1)[1] for line in path.read_text().splitlines() if line.startswith("# public key: ")
    )
    return path, recipient


def _encrypt(data: bytes, *recipients: str) -> bytes:
    argv = ["age"]
    for recipient in recipients:
        argv += ["-r", recipient]
    return subprocess.run(argv, input=data, capture_output=True, check=True).stdout


class FakeDocker:
    """Answers the drill's docker calls. `docker run --network none` calls
    run the real local age/age-keygen with mounts mapped; mysql calls on the
    drill network are answered from `snapshot`; everything else succeeds."""

    def __init__(self, *, snapshot="SITE\t1\t2\t3\tNEWEST POST\n", snapshot_code=0, fail=None):
        self.calls: list[list[str]] = []
        self.envs: list[dict] = []
        self.snapshot = snapshot
        self.snapshot_code = snapshot_code
        self.fail = fail or {}
        self.imports = 0

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        self.envs.append(dict(kwargs.get("env") or {}))
        for marker, result in self.fail.items():
            if marker in " ".join(argv):
                return result(argv) if callable(result) else result
        if argv[:2] == ["docker", "run"] and "--network" in argv and argv[argv.index("--network") + 1] == "none":
            return self._local_age(argv, kwargs)
        if argv[:2] == ["docker", "run"] and "mysql" in argv:
            return self._mysql(argv, kwargs)
        if argv[:2] == ["docker", "port"]:
            port = 49001 if argv[-1].startswith(str(rd.SIDECAR_PORT)) else 49000
            return _completed(argv, out=f"127.0.0.1:{port}\n[::1]:{port}\n")
        return _completed(argv)

    def _local_age(self, argv, kwargs):
        mounts = {}
        index = 2
        while index < len(argv):
            if argv[index] == "-v":
                host, container, _ = argv[index + 1].split(":")
                mounts[container] = host
                index += 2
            elif argv[index] in ("--rm", "-i"):
                index += 1
            elif argv[index] in ("--network", "--log-driver"):
                index += 2
            else:
                break
        command = [mounts.get(part, part) for part in argv[index + 1:]]
        return subprocess.run(command, input=kwargs.get("input"), capture_output=True, check=False)

    def _mysql(self, argv, kwargs):
        if "SELECT 1;" in argv:
            return _completed(argv)
        if "SHOW DATABASES;" in argv:
            return _completed(argv, out="information_schema\nmysql\nperformance_schema\nsys\n")
        if rd.SNAPSHOT_QUERY in argv:
            err = "" if self.snapshot_code == 0 else "ERROR 1049 (42000): Unknown database"
            return _completed(argv, code=self.snapshot_code, out=self.snapshot, err=err)
        if kwargs.get("stdin") is not None:
            self.imports += 1
        return _completed(argv)

    def ran(self, fragment: str) -> bool:
        return any(fragment in " ".join(call) for call in self.calls)


class FakeStore:
    def __init__(self, objects: dict[str, dict[str, bytes]]):
        self.objects = objects

    def list(self, copy, prefix):
        return sorted(k for k in self.objects.get(copy.name, {}) if k.startswith(prefix))

    def get(self, copy, key):
        return self.objects[copy.name][key]

    def head_bytes(self, copy, key, length):
        return self.objects[copy.name][key][:length]


class FakeHttp:
    """Ghost answers 200 with `body`; the sidecar answers 503 while the
    flag exists and 200 once it is gone. Records the order of events."""

    def __init__(self, flag_root: pathlib.Path, body: str):
        self.flag_root = flag_root
        self.body = body
        self.events: list[str] = []

    def _flag_set(self) -> bool:
        return any(self.flag_root.glob(f"run-*/{rd.FLAG_NAME}"))

    def __call__(self, url, timeout_s):
        if url.endswith("/healthz"):
            status = 503 if self._flag_set() else 200
            self.events.append(f"sidecar:{status}")
            return status, ""
        self.events.append("ghost:flag-set" if self._flag_set() else "ghost:flag-clear")
        return 200, self.body


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        self.t += 1.0
        return self.t


class ConfigTests(unittest.TestCase):
    def test_primary_only(self):
        config = rd.config_from_env(_env())
        self.assertEqual([c.name for c in config.copies], ["primary"])
        self.assertEqual(config.copies[0].key_prefix, "dumps/")
        self.assertEqual(config.max_backup_age_s, rd.DEFAULT_MAX_BACKUP_AGE_HOURS * 3600)
        self.assertNotIn("SK", repr(config.copies[0]))

    def test_both_copies_in_order(self):
        extra = {f"BACKUP_DRILL_COPY_SECONDARY_{s}": "v" for s in ("BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")}
        config = rd.config_from_env(_env(**extra, BACKUP_DRILL_COPY_SECONDARY_OBJECT_KEY_PREFIX="db/"))
        self.assertEqual([c.name for c in config.copies], ["primary", "secondary"])
        self.assertEqual(config.copies[1].key_prefix, "db/")

    def test_missing_primary_refused(self):
        with self.assertRaisesRegex(rd.DrillConfigError, "PRIMARY_BUCKET"):
            rd.config_from_env(_env(BACKUP_DRILL_COPY_PRIMARY_BUCKET=None))

    def test_partial_secondary_refused(self):
        with self.assertRaisesRegex(rd.DrillConfigError, "secondary"):
            rd.config_from_env(_env(BACKUP_DRILL_COPY_SECONDARY_BUCKET="b2"))

    def test_tagged_image_refused(self):
        with self.assertRaisesRegex(rd.DrillConfigError, "GHOST_IMAGE"):
            rd.config_from_env(_env(BACKUP_DRILL_GHOST_IMAGE="ghcr.io/x/ghost:latest"))

    def test_bad_max_age_refused(self):
        with self.assertRaisesRegex(rd.DrillConfigError, "not a number"):
            rd.config_from_env(_env(BACKUP_DRILL_MAX_BACKUP_AGE_HOURS="soon"))
        with self.assertRaisesRegex(rd.DrillConfigError, "positive"):
            rd.config_from_env(_env(BACKUP_DRILL_MAX_BACKUP_AGE_HOURS="0"))


class ChoiceTests(unittest.TestCase):
    def test_consecutive_weeks_alternate_two_copies(self):
        start = datetime.datetime(2026, 12, 20, tzinfo=datetime.timezone.utc)
        picks = [rd.choose_for_week(["primary", "secondary"], start + datetime.timedelta(weeks=n)) for n in range(6)]
        for first, second in zip(picks, picks[1:]):
            self.assertNotEqual(first, second)

    def test_one_copy_is_always_chosen(self):
        self.assertEqual(rd.choose_for_week(["primary"], NOW), "primary")

    def test_nothing_to_choose(self):
        with self.assertRaises(rd.DrillConfigError):
            rd.choose_for_week([], NOW)


@unittest.skipUnless(HAVE_AGE, "needs the age binary")
class RecipientCheckTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        _, self.r1 = _keygen(self.dir, "one")
        _, self.r2 = _keygen(self.dir, "two")

    def test_one_x25519_recipient_passes(self):
        rd.check_single_recipient(_encrypt(b"x", self.r1), "obj")

    def test_two_recipients_fail(self):
        with self.assertRaisesRegex(rd.RecipientAuditError, "names 2 recipients"):
            rd.check_single_recipient(_encrypt(b"x", self.r1, self.r2), "obj")

    def test_not_age_fails(self):
        with self.assertRaisesRegex(rd.RecipientAuditError, "not an age v1"):
            rd.check_single_recipient(b"-- MySQL dump\n", "obj")

    def test_truncated_header_fails(self):
        with self.assertRaisesRegex(rd.RecipientAuditError, "no end of age header"):
            rd.check_single_recipient(b"age-encryption.org/v1\n-> X25519 abc\n", "obj")

    def test_non_x25519_recipient_fails(self):
        with self.assertRaisesRegex(rd.RecipientAuditError, "not an X25519"):
            rd.check_single_recipient(b"age-encryption.org/v1\n-> scrypt salt 18\nbody\n--- mac\n", "obj")


def _copy(name="primary"):
    return rd.DrillCopy(name=name, bucket="b", endpoint="e", region="r", access_key="a", secret_key="s")


@unittest.skipUnless(HAVE_AGE, "needs the age binary")
class AuditAndNewestTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        _, self.r1 = _keygen(self.dir, "one")
        _, self.r2 = _keygen(self.dir, "two")

    def test_audits_every_object_of_every_tenant(self):
        store = FakeStore({"primary": {
            "dumps/a/20261001T014000Z.sql.age": _encrypt(b"x", self.r1),
            "dumps/a/20261002T014000Z.sql.age": _encrypt(b"x", self.r1),
            "dumps/b/20261002T014000Z.sql.age": _encrypt(b"x", self.r2),
        }})
        self.assertEqual(rd.audit_recipients(store, _copy(), ["a", "b"]), 3)

    def test_an_old_two_recipient_object_fails_the_audit(self):
        store = FakeStore({"primary": {
            "dumps/a/20200101T000000Z.sql.age": _encrypt(b"x", self.r1, self.r2),
            "dumps/a/20261002T014000Z.sql.age": _encrypt(b"x", self.r1),
        }})
        with self.assertRaisesRegex(rd.RecipientAuditError, "20200101T000000Z"):
            rd.audit_recipients(store, _copy(), ["a"])

    def test_tenant_without_objects_fails(self):
        with self.assertRaises(rd.NoBackupError):
            rd.audit_recipients(FakeStore({"primary": {}}), _copy(), ["a"])

    def test_newest_by_timestamp_ignoring_other_names(self):
        store = FakeStore({"primary": {
            "dumps/a/20261001T014000Z.sql.age": b"",
            "dumps/a/20261003T014000Z.sql.age": b"",
            "dumps/a/notes.txt": b"",
            "dumps/ab/20261009T014000Z.sql.age": b"",
        }})
        newest = rd.newest_backup(store, _copy(), "a")
        self.assertEqual(newest.key, "dumps/a/20261003T014000Z.sql.age")
        self.assertEqual(newest.taken_at, datetime.datetime(2026, 10, 3, 1, 40, tzinfo=datetime.timezone.utc))

    def test_no_dump_named_object(self):
        with self.assertRaises(rd.NoBackupError):
            rd.newest_backup(FakeStore({"primary": {"dumps/a/x": b""}}), _copy(), "a")


class ObjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.s3 = mock.Mock()
        self.store = rd.ObjectStore(self.s3)

    def test_list_and_get_pass_the_copy_credentials(self):
        self.s3.list_objects.return_value = [{"key": "k1"}, {"key": "k2"}]
        self.s3.get_object.return_value = b"data"
        self.assertEqual(self.store.list(_copy(), "p/"), ["k1", "k2"])
        self.assertEqual(self.store.get(_copy(), "k1"), b"data")
        kwargs = self.s3.list_objects.call_args.kwargs
        self.assertEqual((kwargs["bucket"], kwargs["secret_key"], kwargs["prefix"]), ("b", "s", "p/"))

    def test_head_bytes_is_a_range_request(self):
        self.s3.signed_request.return_value = (206, b"0123456789")
        self.assertEqual(self.store.head_bytes(_copy(), "k", 4), b"0123")
        self.assertEqual(self.s3.signed_request.call_args.kwargs["extra_headers"], {"range": "bytes=0-3"})

    def test_head_bytes_refuses_an_error_status(self):
        self.s3.signed_request.return_value = (403, b"denied")
        with self.assertRaisesRegex(rd.DrillError, "HTTP 403"):
            self.store.head_bytes(_copy(), "k", 4)


@unittest.skipUnless(HAVE_AGE, "needs the age binary")
class ErasureTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.ids = self.dir / "ids"
        self.scratch = self.dir / "scratch"
        self.ids.mkdir()
        self.scratch.mkdir()
        _keygen(self.ids, "blog")

    def test_destroyed_key_fails_for_the_right_reason(self):
        docker = FakeDocker()
        reason = rd.prove_erasure(runner=docker, image="img", identity_dir=self.ids, scratch_dir=self.scratch)
        self.assertIn(rd.NO_IDENTITY_MATCHED, reason)
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertTrue(docker.ran("age-keygen"))

    def test_a_kept_key_breaks_erasure(self):
        def keep_key(path):
            shutil.copy(path, self.ids / f"kept{rd.IDENTITY_SUFFIX}")
            path.unlink()

        with mock.patch.object(rd, "_destroy_file", keep_key):
            with self.assertRaises(rd.ErasureBrokenError):
                rd.prove_erasure(runner=FakeDocker(), image="img", identity_dir=self.ids, scratch_dir=self.scratch)

    def test_a_key_left_on_disk_is_refused(self):
        with mock.patch.object(rd, "_destroy_file", lambda path: None):
            with self.assertRaisesRegex(rd.DrillError, "still exists"):
                rd.prove_erasure(runner=FakeDocker(), image="img", identity_dir=self.ids, scratch_dir=self.scratch)

    def test_a_failure_for_another_reason_is_not_erasure(self):
        docker = FakeDocker()
        real = docker._local_age

        def local_age(argv, kwargs):
            ids = [a for a in argv if a.startswith(str(self.ids))]
            if ids:
                return _completed(argv, code=1, out=b"", err=b"age: error: failed to read header: unexpected EOF")
            return real(argv, kwargs)

        docker._local_age = local_age
        with self.assertRaisesRegex(rd.ErasureWrongReasonError, "unexpected EOF"):
            rd.prove_erasure(runner=docker, image="img", identity_dir=self.ids, scratch_dir=self.scratch)

    def test_keygen_failure(self):
        docker = FakeDocker(fail={"age-keygen": _completed([], code=1, out=b"", err=b"boom")})
        with self.assertRaisesRegex(rd.DrillError, "age-keygen"):
            rd.prove_erasure(runner=docker, image="img", identity_dir=self.ids, scratch_dir=self.scratch)

    def test_encrypt_failure(self):
        def fail_encrypt(argv):
            if "-r" in argv:
                return _completed(argv, code=1, out=b"", err=b"bad")
            return None

        docker = FakeDocker()
        real = docker._local_age
        docker._local_age = lambda argv, kw: fail_encrypt(argv) or real(argv, kw)
        with self.assertRaisesRegex(rd.DrillError, "could not encrypt"):
            rd.prove_erasure(runner=docker, image="img", identity_dir=self.ids, scratch_dir=self.scratch)

    def test_own_key_must_open_it_before_destruction(self):
        docker = FakeDocker()
        real = docker._local_age

        def local_age(argv, kwargs):
            if any(f"shredded{rd.IDENTITY_SUFFIX}:" in a for a in argv):
                return _completed(argv, code=0, out=b"something else", err=b"")
            return real(argv, kwargs)

        docker._local_age = local_age
        with self.assertRaisesRegex(rd.DrillError, "before destruction"):
            rd.prove_erasure(runner=docker, image="img", identity_dir=self.ids, scratch_dir=self.scratch)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_no_held_identity_is_a_config_error(self):
        for key in self.ids.iterdir():
            key.unlink()
        with self.assertRaises(rd.DrillConfigError):
            rd.prove_erasure(runner=FakeDocker(), image="img", identity_dir=self.ids, scratch_dir=self.scratch)


class DestroyFileTests(unittest.TestCase):
    def test_overwrites_then_unlinks_and_tolerates_absence(self):
        directory = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        path = directory / "k"
        path.write_bytes(b"secret")
        written = []
        real_open = open

        def spy_open(p, mode="r", *a, **kw):
            handle = real_open(p, mode, *a, **kw)
            if "+" in mode:
                original = handle.write
                handle.write = lambda data: (written.append(data), original(data))[1]
            return handle

        with mock.patch("builtins.open", spy_open):
            rd._destroy_file(path)
        self.assertEqual(written, [b"\0" * 6])
        self.assertFalse(path.exists())
        rd._destroy_file(path)


MANIFEST = bm.Manifest(site_title="SITE", users=1, published_posts=2, members=3,
                       newest_post_title="NEWEST POST", newest_post_slug="newest-post")


class SnapshotTests(unittest.TestCase):
    def _run(self, out="", code=0, err=""):
        return lambda argv, **kw: _completed(argv, code=code, out=out, err=err)

    def _content(self, out="SITE\t1\t2\t3\tNEWEST POST\n", code=0, err=""):
        return rd.snapshot_restored_content(run=self._run(out, code, err), host="h", password="p", database="ghost_a")

    def test_parses_the_row(self):
        content = self._content("My\\tSite\t2\t5\t7\tA \\\\ post\n")
        self.assertEqual((content.site_title, content.users, content.published_posts, content.members),
                         ("My\tSite", 2, 5, 7))
        self.assertEqual(content.newest_post_title, "A \\ post")

    def test_a_restore_matching_its_backup_passes(self):
        rd.compare_with_manifest(self._content(), MANIFEST)
        self.assertEqual(rd.expected_from_manifest(MANIFEST), ("SITE", "NEWEST POST"))

    def test_ghost_install_defaults_are_refused(self):
        defaults = self._content("Ghost\t1\t1\t0\tComing soon\n")
        with self.assertRaisesRegex(rd.ContentFloorError, "site_title: restored 'Ghost', backed up 'SITE'"):
            rd.compare_with_manifest(defaults, MANIFEST)

    def test_a_missing_member_is_refused(self):
        with self.assertRaisesRegex(rd.ContentFloorError, "members: restored 2, backed up 3"):
            rd.compare_with_manifest(self._content("SITE\t1\t2\t2\tNEWEST POST\n"), MANIFEST)

    def test_nulls(self):
        content = self._content("NULL\t1\t0\t0\tNULL\n")
        self.assertEqual((content.site_title, content.newest_post_title), ("", None))

    def test_no_schema_is_the_empty_restore(self):
        content = self._content("", code=1, err="Unknown database")
        with self.assertRaisesRegex(rd.ContentFloorError, "no Ghost schema.*Unknown database"):
            rd.compare_with_manifest(content, MANIFEST)

    def test_malformed_output_is_a_problem(self):
        with self.assertRaisesRegex(rd.ContentFloorError, "unexpected snapshot output"):
            rd.compare_with_manifest(self._content("x\ty\n"), MANIFEST)


class ManifestReadTests(unittest.TestCase):
    def test_reads_the_trailer(self):
        self.assertEqual(rd.read_manifest(b"-- dump\n" + MANIFEST.to_trailer()), MANIFEST)

    def test_no_manifest_is_refused(self):
        with self.assertRaisesRegex(rd.ContentFloorError, "carries no manifest"):
            rd.read_manifest(b"")

    def test_a_manifest_with_an_error_is_refused(self):
        bad = bm.Manifest("SITE", 1, 0, 0, None, None, error="ValueError: x")
        with self.assertRaisesRegex(rd.ContentFloorError, "not recorded cleanly"):
            rd.read_manifest(bad.to_trailer())

    def test_a_manifest_with_nothing_to_assert_is_refused(self):
        for empty in (bm.Manifest(None, 1, 0, 0, None, None), bm.Manifest("T", 0, 0, 0, None, None)):
            with self.assertRaisesRegex(rd.ContentFloorError, "no site title or no staff user"):
                rd.read_manifest(empty.to_trailer())


class VolatileWorkDirTests(unittest.TestCase):
    MOUNTS = "sysfs /sys sysfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\nbad\n"

    def test_longest_mount_wins(self):
        self.assertEqual(rd.mount_filesystem(pathlib.Path("/run/branchleft-restore-drill/work"), self.MOUNTS), "tmpfs")
        self.assertEqual(rd.mount_filesystem(pathlib.Path("/var/lib/x"), self.MOUNTS), "ext4")

    def test_require_volatile(self):
        directory = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        mounts = directory / "mounts"
        mounts.write_text(f"/dev/sda1 / ext4 rw 0 0\ntmpfs {directory.resolve()} tmpfs rw 0 0\n")
        rd.require_volatile(directory, str(mounts))
        mounts.write_text("/dev/sda1 / ext4 rw 0 0\n")
        with self.assertRaisesRegex(rd.DrillConfigError, "on ext4, not tmpfs"):
            rd.require_volatile(directory, str(mounts))
        with self.assertRaisesRegex(rd.DrillConfigError, "cannot tell"):
            rd.require_volatile(directory, str(directory / "absent"))


class RunnerAdapterTests(unittest.TestCase):
    def test_mysql_runs_in_the_recovery_image_with_the_password_out_of_argv(self):
        docker = FakeDocker()
        run = rd.container_mysql_runner(runner=docker, image="rec" + DIGEST, network="net")
        run(["mysql", "-e", "SELECT 1;"], env={"MYSQL_PWD": "pw"}, capture_output=True, text=True)
        with open(os.devnull, "rb") as stdin:
            run(["mysql"], env={"MYSQL_PWD": "pw"}, stdin=stdin)
        first, second = docker.calls
        self.assertEqual(first[:7], ["docker", "run", "--rm", "--log-driver", "none", "--network", "net"])
        self.assertNotIn("-i", first)
        self.assertIn("-i", second)
        self.assertNotIn("pw", " ".join(first + second))
        self.assertEqual(docker.envs[0]["MYSQL_PWD"], "pw")


class ContainersTests(unittest.TestCase):
    def test_sweep_removes_labelled_leftovers(self):
        docker = FakeDocker(fail={
            "ps -aq": _completed([], out="c1\nc2\n"),
            "network ls": _completed([], out="n1\n"),
        })
        rd.Containers(runner=docker, run_id="r").sweep()
        self.assertIn(["docker", "rm", "-f", "-v", "c1", "c2"], docker.calls)
        self.assertIn(["docker", "network", "rm", "n1"], docker.calls)

    def test_sweep_with_nothing_left(self):
        docker = FakeDocker()
        rd.Containers(runner=docker, run_id="r").sweep()
        self.assertEqual(len(docker.calls), 2)

    def test_secrets_cross_as_environment_never_argv(self):
        docker = FakeDocker()
        containers = rd.Containers(runner=docker, run_id="r")
        containers.start_mysql(image="m" + DIGEST, password="rootpw", memory="1g")
        ports = containers.start_colour(ghost_image="g" + DIGEST, sidecar_image="s" + DIGEST, database="ghost_a",
                                        password="rootpw", memory="1g", flag_dir="/run/x")
        self.assertEqual(ports, (49000, 49001))
        self.assertNotIn("rootpw", " ".join(" ".join(c) for c in docker.calls))
        self.assertIn("rootpw", [e.get("MYSQL_ROOT_PASSWORD") for e in docker.envs])
        self.assertIn("rootpw", [e.get("database__connection__password") for e in docker.envs])
        sidecar = next(c for c in docker.calls if "container:restore-drill-ghost-r" in c)
        self.assertIn(f"/run/x:{rd.FLAG_MOUNT_DIR}:ro", sidecar)
        for call in docker.calls:
            if call[:3] == ["docker", "run", "-d"]:
                self.assertIn(f"{rd.CONTAINER_LABEL}=r", call)

    def test_pull_only_the_images_not_already_present(self):
        images = rd.Images(recovery="r" + DIGEST, mysql="m" + DIGEST, ghost="g" + DIGEST, sidecar="s" + DIGEST)
        docker = FakeDocker(fail={"inspect --format {{.Id}} g": _completed([], code=1, err="No such image")})
        rd.Containers(runner=docker, run_id="r").pull(images)
        pulls = [c[-1] for c in docker.calls if c[1] == "pull"]
        self.assertEqual(pulls, [images.ghost])

    def test_docker_failure_is_a_drill_error(self):
        docker = FakeDocker(fail={
            "image inspect": _completed([], code=1, err="No such image"),
            "pull": _completed([], code=1, err="denied"),
        })
        with self.assertRaisesRegex(rd.DrillError, "denied"):
            rd.Containers(runner=docker, run_id="r").pull(
                rd.Images(recovery="r", mysql="m", ghost="g", sidecar="s"))

    def test_unpublished_port(self):
        docker = FakeDocker(fail={"docker port": _completed([], out="")})
        with self.assertRaisesRegex(rd.DrillError, "publishes nothing"):
            rd.Containers(runner=docker, run_id="r").host_port(2368)


class WaitForStatusTests(unittest.TestCase):
    def test_times_out_naming_the_last_status(self):
        with self.assertRaisesRegex(rd.ColourStateError, "answered 200, never 503"):
            rd.wait_for_status(get=lambda url, t: (200, ""), url="u", want=503, timeout_s=3, sleep=lambda s: None,
                               now=Clock())

    def test_http_get_reports_every_outcome_as_a_status(self):
        response = mock.MagicMock(status=200)
        response.read.return_value = b"<p>ok</p>"
        response.__enter__.return_value = response
        error = rd.urllib.error.HTTPError("u", 503, "drained", {}, io.BytesIO(b"drained"))
        with mock.patch.object(rd.urllib.request, "urlopen", side_effect=[response, error, OSError("refused")]) as op:
            self.assertEqual(rd.http_get("http://127.0.0.1:1/", 1), (200, "<p>ok</p>"))
            self.assertEqual(rd.http_get("http://127.0.0.1:1/", 1), (503, "drained"))
            self.assertEqual(rd.http_get("http://127.0.0.1:1/", 1), (0, "refused"))
        self.assertEqual(op.call_args_list[0].args[0].get_header("X-forwarded-proto"), "https")

    def test_unescaping_get(self):
        get = rd.unescaping_get(lambda url, t: (200, "Tom &amp; Jerry&#x27;s"))
        self.assertEqual(get("u", 1), (200, "Tom & Jerry's"))


@unittest.skipUnless(HAVE_AGE, "needs the age binary")
class RunDrillTests(unittest.TestCase):
    """The whole chain against fakes, with real age on real ciphertext."""

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.ids = self.dir / "ids"
        self.ids.mkdir()
        _, self.recipient = _keygen(self.ids, "blog")
        self.config = rd.DrillConfig(
            copies=(_copy("primary"), _copy("secondary")),
            images=rd.Images(recovery="r" + DIGEST, mysql="m" + DIGEST, ghost="g" + DIGEST, sidecar="s" + DIGEST),
            identity_dir=self.ids, work_dir=self.dir / "work", flag_root=self.dir / "flags",
            metrics_dir=self.dir / "metrics", max_backup_age_s=48 * 3600, require_volatile_work_dir=False,
        )
        self.plaintext = b"CREATE DATABASE ghost_blog;\n" + MANIFEST.to_trailer()
        dump = _encrypt(self.plaintext, self.recipient)
        self.key = "dumps/blog/20261003T014000Z.sql.age"
        self.store = FakeStore({"primary": {self.key: dump}, "secondary": {self.key: dump}})

    def hooks(self, docker, body="<title>SITE</title><h2>NEWEST POST</h2>"):
        self.http = FakeHttp(self.config.flag_root, body)
        return rd.Hooks(runner=docker, store=self.store, get=self.http, sleep=lambda s: None, clock=Clock(),
                        now=lambda: NOW, run_id=lambda: "abcd", content_timeout_s=3, sidecar_timeout_s=3)

    def assert_cleaned_up(self, docker):
        self.assertIn(["docker", "rm", "-f", "-v", "restore-drill-mysql-abcd"], docker.calls)
        self.assertIn(["docker", "network", "rm", "restore-drill-abcd"], docker.calls)
        self.assertFalse((self.config.work_dir / "run-abcd").exists())
        self.assertFalse((self.config.flag_root / "run-abcd").exists())

    def test_green(self):
        docker = FakeDocker()
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(docker), copy_name="primary")
        self.assertTrue(report.ok, report.error)
        self.assertEqual((report.tenant, report.copy, report.object_key), ("blog", "primary", self.key))
        self.assertEqual(report.objects_audited, 1)
        self.assertEqual(report.bytes_recovered, len(self.plaintext))
        self.assertEqual(report.content.site_title, "SITE")
        self.assertEqual(report.manifest, MANIFEST)
        transient = [c for c in docker.calls if c[:3] == ["docker", "run", "--rm"]]
        self.assertGreaterEqual(len(transient), 6)
        for call in transient:
            pairs = list(zip(call, call[1:]))
            self.assertIn(("--log-driver", "none"), pairs, call)
        self.assertIn(rd.NO_IDENTITY_MATCHED, report.erasure_reason)
        self.assertAlmostEqual(report.object_age_s, (NOW - datetime.datetime(2026, 10, 3, 1, 40, tzinfo=datetime.timezone.utc)).total_seconds())
        self.assertEqual(docker.imports, 1)
        self.assertEqual(self.http.events[0], "sidecar:503")
        self.assertEqual(self.http.events[-1], "sidecar:200")
        self.assertTrue(all(e == "ghost:flag-set" for e in self.http.events if e.startswith("ghost")))
        self.assert_cleaned_up(docker)

    def test_copy_follows_the_week_when_not_named(self):
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(FakeDocker()))
        self.assertEqual(report.copy, rd.choose_for_week(["primary", "secondary"], NOW))

    def test_empty_restore_is_refused_before_any_colour_starts(self):
        docker = FakeDocker(snapshot="", snapshot_code=1)
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(docker), copy_name="primary")
        self.assertFalse(report.ok)
        self.assertIn("ContentFloorError", report.error)
        self.assertFalse(docker.ran("restore-drill-ghost-abcd --network"))
        self.assertEqual(self.http.events, [])
        self.assert_cleaned_up(docker)

    def test_ghost_defaults_restored_are_refused_before_any_colour_starts(self):
        docker = FakeDocker(snapshot="Ghost\t1\t1\t0\tComing soon\n")
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(docker), copy_name="primary")
        self.assertIn("site_title: restored 'Ghost', backed up 'SITE'", report.error or "")
        self.assertEqual(self.http.events, [])

    def test_a_backup_without_a_manifest_is_refused(self):
        self.store.objects["primary"][self.key] = _encrypt(b"CREATE DATABASE ghost_blog;\n", self.recipient)
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(FakeDocker()), copy_name="primary")
        self.assertIn("carries no manifest", report.error)
        self.assert_cleaned_up_files()

    def test_the_page_must_carry_the_backed_up_title_not_the_restored_one(self):
        docker = FakeDocker()
        report = rd.run_drill(config=self.config, tenants=["blog"],
                              hooks=self.hooks(docker, body="<title>Ghost</title><h2>NEWEST POST</h2>"),
                              copy_name="primary")
        self.assertIn("'SITE' not found", report.error)

    def test_without_the_comparison_the_page_is_still_checked_against_the_backup(self):
        docker = FakeDocker(snapshot="Ghost\t1\t1\t0\tComing soon\n")
        with mock.patch.object(rd, "compare_with_manifest", lambda content, manifest: None):
            report = rd.run_drill(config=self.config, tenants=["blog"],
                                  hooks=self.hooks(docker, body="<title>Ghost</title><h2>Coming soon</h2>"),
                                  copy_name="primary")
        self.assertIn("'SITE' not found", report.error or "")
        self.assertNotIn("sidecar:200", self.http.events)

    def test_stale_run_directories_are_swept(self):
        for root in (self.config.work_dir, self.config.flag_root):
            (root / "run-dead" / "x").mkdir(parents=True)
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(FakeDocker()), copy_name="primary")
        self.assertTrue(report.ok, report.error)
        self.assertFalse((self.config.work_dir / "run-dead").exists())
        self.assertFalse((self.config.flag_root / "run-dead").exists())

    def test_a_non_volatile_work_dir_is_refused_before_decrypting(self):
        config = dataclasses.replace(self.config, require_volatile_work_dir=True)
        docker = FakeDocker()
        with mock.patch.object(rd, "require_volatile", side_effect=rd.DrillConfigError("on ext4, not tmpfs")):
            report = rd.run_drill(config=config, tenants=["blog"], hooks=self.hooks(docker), copy_name="primary")
        self.assertIn("not tmpfs", report.error or "")
        self.assertFalse(docker.ran("age --decrypt"))

    def test_sigterm_mid_run_removes_containers_and_the_decrypted_dump(self):
        def interrupt(argv):
            self.assertTrue((self.config.work_dir / "run-abcd" / "dump.sql").exists())
            raise rd.DrillInterrupted()

        docker = FakeDocker(fail={"network create": interrupt})
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(docker), copy_name="primary")
        self.assertTrue(report.interrupted)
        self.assertIn("SIGTERM", report.error)
        self.assert_cleaned_up(docker)

    def assert_cleaned_up_files(self):
        self.assertFalse((self.config.work_dir / "run-abcd").exists())
        self.assertFalse((self.config.flag_root / "run-abcd").exists())

    def test_content_missing_from_the_page_never_undrains(self):
        docker = FakeDocker()
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(docker, body="<title>Ghost</title>"),
                              copy_name="primary")
        self.assertFalse(report.ok)
        self.assertIn("ContentVerificationError", report.error)
        self.assertNotIn("sidecar:200", self.http.events)

    def test_colour_not_drained_is_refused(self):
        docker = FakeDocker()
        hooks = self.hooks(docker)
        hooks.get = lambda url, t: (200, "SITE NEWEST POST")
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=hooks, copy_name="primary")
        self.assertIn("ColourStateError", report.error)

    def test_stale_backup(self):
        hooks = self.hooks(FakeDocker())
        hooks.now = lambda: NOW + datetime.timedelta(days=3)
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=hooks, copy_name="primary")
        self.assertIn("StaleBackupError", report.error)

    def test_missing_identity(self):
        report = rd.run_drill(config=self.config, tenants=["other"], hooks=self.hooks(FakeDocker()), tenant="other")
        self.assertIn("DrillConfigError", report.error)

    def test_invalid_tenant_name(self):
        report = rd.run_drill(config=self.config, tenants=["Bad_Name"], hooks=self.hooks(FakeDocker()))
        self.assertIn("InvalidTenantName", report.error)

    def test_unknown_copy(self):
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(FakeDocker()), copy_name="third")
        self.assertIn("no configured copy", report.error)

    def test_wrong_key_cannot_decrypt(self):
        _, other = _keygen(self.dir, "other")
        self.store.objects["primary"][self.key] = _encrypt(b"x", other)
        report = rd.run_drill(config=self.config, tenants=["blog"], hooks=self.hooks(FakeDocker()), copy_name="primary")
        self.assertIn("DecryptError", report.error)


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = self.dir / rd.METRICS_FILENAME

    def _gauge(self, name):
        for line in self.path.read_text().splitlines():
            if line.startswith(rd.METRIC_PREFIX + name + " "):
                return float(line.split()[1])
        return None

    def test_success_then_failure_keeps_the_last_success(self):
        ok = rd.DrillReport(tenant="blog", copy="primary", ok=True, restore_s=1.0, verify_s=2.0, object_age_s=3.0,
                            bytes_recovered=10, objects_audited=4)
        rd.record_metrics(ok, metrics_dir=self.dir, ran_at=1000.0)
        self.assertEqual(self._gauge("last_success_timestamp_seconds"), 1000.0)
        self.assertEqual(self._gauge("last_run_success"), 1.0)
        self.assertIn('restore_drill_last_run_info{tenant="blog",copy="primary"} 1', self.path.read_text())
        rd.record_metrics(rd.DrillReport(tenant="blog", copy="primary", error="x"), metrics_dir=self.dir, ran_at=2000.0)
        self.assertEqual(self._gauge("last_success_timestamp_seconds"), 1000.0)
        self.assertEqual(self._gauge("last_run_timestamp_seconds"), 2000.0)
        self.assertEqual(self._gauge("last_run_success"), 0.0)
        self.assertIsNone(self._gauge("restore_duration_seconds"))

    def test_never_succeeded_exports_no_last_success(self):
        rd.record_metrics(rd.DrillReport(tenant="blog", copy="primary"), metrics_dir=self.dir, ran_at=5.0)
        self.assertIsNone(self._gauge("last_success_timestamp_seconds"))


class MainTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.tenants = self.dir / "tenants"
        self.tenants.write_text("# comment\nblog\n\nblog\n")
        self.env = _env(BACKUP_DRILL_FLAG_ROOT=str(self.dir / "flags"), BACKUP_DRILL_METRICS_DIR=str(self.dir))
        self.hooks = rd.Hooks(now=lambda: NOW)

    def _main(self, report=None, argv=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(rd, "run_drill", return_value=report) as run, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rd.main(argv or ["--tenants-file", str(self.tenants)], hooks=self.hooks, environ=self.env)
        return code, out.getvalue(), err.getvalue(), run

    def test_pass_exports_and_exits_zero(self):
        report = rd.DrillReport(tenant="blog", copy="primary", ok=True, restore_s=1, verify_s=1, object_age_s=3600,
                                content=rd.RestoredContent("ghost_blog", "T", 1, 1, 0, "P"),
                                erasure_reason="age: error: no identity matched any of the recipients")
        code, out, _, run = self._main(report)
        self.assertEqual(code, 0)
        self.assertEqual(run.call_args.kwargs["tenants"], ["blog"])
        self.assertIn("PASS", out)
        self.assertIn("right reason", out)
        self.assertTrue((self.dir / rd.METRICS_FILENAME).exists())

    def test_failure_exits_one(self):
        code, _, err, _ = self._main(rd.DrillReport(tenant="blog", copy="primary", error="ContentFloorError: x"))
        self.assertEqual(code, 1)
        self.assertIn("FAIL ContentFloorError", err)

    def test_config_error_exits_two(self):
        self.env.pop("BACKUP_DRILL_GHOST_IMAGE")
        code, _, err, run = self._main()
        self.assertEqual(code, 2)
        run.assert_not_called()

    def test_empty_tenants_file_exits_two(self):
        self.tenants.write_text("# nothing\n")
        code, _, err, _ = self._main()
        self.assertEqual((code, "names no tenant" in err), (2, True))

    def test_lock_held_exits_two(self):
        with mock.patch.object(rd.fcntl, "flock", side_effect=BlockingIOError("held")):
            code, _, err, run = self._main()
        self.assertEqual(code, 2)
        run.assert_not_called()

    def test_content_timeout_from_the_environment(self):
        self.env["BACKUP_DRILL_CONTENT_TIMEOUT_S"] = "42"
        self._main(rd.DrillReport(tenant="blog", copy="primary", error="x"))
        self.assertEqual(self.hooks.content_timeout_s, 42.0)
        self.env["BACKUP_DRILL_CONTENT_TIMEOUT_S"] = "soon"
        code, _, err, _ = self._main()
        self.assertEqual((code, "not a number" in err), (2, True))

    def test_unwritable_metrics_exits_one(self):
        report = rd.DrillReport(tenant="blog", copy="primary", error="x")
        with mock.patch.object(rd, "record_metrics", side_effect=OSError("read-only")):
            code, _, err, _ = self._main(report)
        self.assertEqual(code, 1)
        self.assertIn("could not export", err)


_SIGTERM_CHILD = r"""
import pathlib, sys, time
sys.path.insert(0, sys.argv[1])
import test_restore_drill as t
import restore_drill as rd

root = pathlib.Path(sys.argv[2])
ids = root / "ids"
recipient = sys.argv[3]
env = t._env(BACKUP_DRILL_IDENTITY_DIR=str(ids), BACKUP_DRILL_WORK_DIR=str(root / "work"),
             BACKUP_DRILL_FLAG_ROOT=str(root / "flags"), BACKUP_DRILL_METRICS_DIR=str(root / "metrics"),
             BACKUP_DRILL_REQUIRE_VOLATILE_WORK_DIR="0")
dump = t._encrypt(b"CREATE DATABASE ghost_blog;\n" + t.MANIFEST.to_trailer(), recipient)
store = t.FakeStore({"primary": {"dumps/blog/20261003T014000Z.sql.age": dump}})

def block(argv):
    (root / "ready").write_text("dump on disk")
    time.sleep(60)

docker = t.FakeDocker(fail={"network create": block})
hooks = rd.Hooks(runner=docker, store=store, now=lambda: t.NOW, run_id=lambda: "sig1")
code = rd.main(["--tenants-file", str(root / "tenants"), "--copy", "primary"], hooks=hooks, environ=env)
removed = [c for c in docker.calls if c[:4] == ["docker", "rm", "-f", "-v"]]
(root / "removed").write_text(str(len(removed)))
sys.exit(code)
"""


@unittest.skipUnless(HAVE_AGE, "needs the age binary")
class SigtermTests(unittest.TestCase):
    """A real SIGTERM, delivered to a real process mid-restore, after the
    decrypted dump has been written: the run must still clean up."""

    def test_sigterm_cleans_up_and_exits_143(self):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        (root / "ids").mkdir()
        _, recipient = _keygen(root / "ids", "blog")
        (root / "tenants").write_text("blog\n")
        child = subprocess.Popen(
            [sys.executable, "-c", _SIGTERM_CHILD, str(pathlib.Path(__file__).parent), str(root), recipient],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        deadline = time.monotonic() + 60
        while not (root / "ready").exists():
            self.assertIsNone(child.poll(), child.stderr.read() if child.poll() is not None else "")
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        self.assertTrue((root / "work" / "run-sig1" / "dump.sql").exists())
        child.send_signal(signal.SIGTERM)
        _, err = child.communicate(timeout=60)
        self.assertEqual(child.returncode, 143, err)
        self.assertFalse((root / "work" / "run-sig1").exists())
        self.assertFalse((root / "flags" / "run-sig1").exists())
        self.assertEqual((root / "removed").read_text(), "3")
        self.assertIn("restore_drill_last_run_success 0.0", (root / "metrics" / rd.METRICS_FILENAME).read_text())
        self.assertIn(b"SIGTERM", err)

    def test_handler_ignores_a_second_sigterm_and_raises(self):
        previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        with self.assertRaises(rd.DrillInterrupted):
            rd._on_sigterm(signal.SIGTERM, None)
        self.assertEqual(signal.getsignal(signal.SIGTERM), signal.SIG_IGN)


class CleanupModeTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.env = {"BACKUP_DRILL_WORK_DIR": str(self.root / "work"), "BACKUP_DRILL_FLAG_ROOT": str(self.root / "flags")}

    def test_removes_containers_and_stale_runs(self):
        (self.root / "work" / "run-old").mkdir(parents=True)
        (self.root / "flags" / "run-old").mkdir(parents=True)
        (self.root / "flags" / "drill.lock").write_text("")
        docker = FakeDocker(fail={"ps -aq": _completed([], out="c1\n")})
        with contextlib.redirect_stdout(io.StringIO()):
            code = rd.main(["--cleanup"], hooks=rd.Hooks(runner=docker), environ=self.env)
        self.assertEqual(code, 0)
        self.assertIn(["docker", "rm", "-f", "-v", "c1"], docker.calls)
        self.assertEqual(sorted(p.name for p in (self.root / "flags").iterdir()), ["drill.lock"])
        self.assertEqual(list((self.root / "work").iterdir()), [])

    def test_docker_failure_is_reported(self):
        docker = FakeDocker(fail={"ps -aq": _completed([], code=1, err="daemon down")})
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = rd.main(["--cleanup"], hooks=rd.Hooks(runner=docker), environ=self.env)
        self.assertEqual(code, 1)
        self.assertIn("daemon down", err.getvalue())


if __name__ == "__main__":
    unittest.main()

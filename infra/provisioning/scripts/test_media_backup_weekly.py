#!/usr/bin/env python3
"""Unit tests for media_backup_weekly.py. The storage is a fake that records
every request; `age` and `ssh-keygen` are the real binaries.
See test_media_backup_weekly.md#module-overview.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from typing import Any
from unittest import mock

import backup_recipients
import media_backup_restore as mbr
import media_backup_weekly as weekly
import shared_objectstorage as shared

TOOLS = shutil.which("age") and shutil.which("age-keygen") and shutil.which("ssh-keygen")

FOLDER_A = "folderaaaaaaaaaaaaaaaa"
FOLDER_B = "folderbbbbbbbbbbbbbbbb"
SHARD_1 = "shared-shard-1"
SHARD_2 = "shared-shard-2"
BACKUP = "tenant-backups"
SECRET_MARKER = b"PLAINTEXT-MARKER-4f1c"


def _identity() -> tuple[str, str]:
    """A real age key pair: (identity text, recipient)."""
    out = subprocess.run(["age-keygen"], capture_output=True, check=True, text=True)
    recipient = next(line.split()[-1] for line in (out.stdout + out.stderr).splitlines() if line.startswith("Public key:") or "public key:" in line.lower())
    return out.stdout, recipient


class FakeProvider:
    """Both endpoints in one place: the shared buckets (read) and the backup
    bucket (written). Records every request so a test can say what was touched."""

    def __init__(self) -> None:
        self.live: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.backup: dict[str, bytes] = {}
        self.fetched: list[tuple[str, str]] = []
        self.listed: list[tuple[str, str]] = []
        self.statuses: list[int] = []  # queued answers; 503 entries come first
        self.calls = 0

    def add(self, bucket: str, key: str, data: bytes) -> None:
        self.live[(bucket, key)] = (data, "image/jpeg")

    def _slowdown(self) -> bool:
        self.calls += 1
        if self.statuses:
            return self.statuses.pop(0) == 503
        return False

    def get(self, url: str, headers: dict[str, str]) -> tuple[int, bytes]:
        if self._slowdown():
            return 503, b"<Error><Code>SlowDown</Code></Error>"
        bucket = url.split("//", 1)[1].split("/", 1)[1].split("?")[0]
        query = url.split("?", 1)[1] if "?" in url else ""
        prefix = ""
        for part in query.split("&"):
            if part.startswith("prefix="):
                prefix = part[len("prefix="):].replace("%2F", "/")
        self.listed.append((bucket, prefix))
        keys = sorted(k for (b, k) in self.live if b == bucket and k.startswith(prefix))
        body = "<ListBucketResult xmlns='http://s3.amazonaws.com/doc/2006-03-01/'><IsTruncated>false</IsTruncated>"
        body += "".join(f"<Contents><Key>{k}</Key><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>" for k in keys)
        return 200, (body + "</ListBucketResult>").encode()

    def get_with_headers(self, url: str, headers: dict[str, str]) -> tuple[int, bytes, dict[str, str]]:
        if self._slowdown():
            return 503, b"<Error><Code>SlowDown</Code></Error>", {}
        path = url.split("//", 1)[1].split("/", 1)[1].split("?")[0]
        bucket, key = path.split("/", 1)
        self.fetched.append((bucket, key))
        data, content_type = self.live[(bucket, key)]
        return 200, data, {"Content-Type": content_type}

    def put(self, url: str, headers: dict[str, str], payload: bytes) -> tuple[int, bytes]:
        if self._slowdown():
            return 503, b"<Error><Code>SlowDown</Code></Error>"
        path = url.split("//", 1)[1].split("/", 1)[1]
        bucket, key = path.split("/", 1)
        assert bucket == BACKUP, f"a write went to {bucket}"
        self.backup[key] = payload
        return 200, b""


class FakePacer(weekly.RequestPacer):
    pass


def _quick_transport(provider: FakeProvider, pacer: weekly.RequestPacer) -> weekly.PacedTransport:
    return weekly.PacedTransport(
        pacer,
        sleep=lambda _s: None,
        jitter=lambda: 0.0,
        get=provider.get,
        put=provider.put,
        get_with_headers=provider.get_with_headers,
    )


def _pacer(rate: float = 100.0) -> weekly.RequestPacer:
    return weekly.RequestPacer(ceiling=rate, clock=lambda: 0.0, sleep=lambda _s: None)


@unittest.skipUnless(TOOLS, "age, age-keygen and ssh-keygen are needed")
class RunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        self.key = self.dir / "signing"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.key)], check=True)
        self.id_a, self.rec_a = _identity()
        self.id_b, self.rec_b = _identity()
        self.provider = FakeProvider()
        self.provider.add(SHARD_1, f"{FOLDER_A}/2026/01/a.jpg", b"alpha " + SECRET_MARKER)
        self.provider.add(SHARD_1, f"{FOLDER_A}/2026/01/b.jpg", b"beta " + SECRET_MARKER)
        self.provider.add(SHARD_2, f"{FOLDER_B}/2026/02/c.jpg", b"gamma " + SECRET_MARKER)
        # A neighbour on the same shard that no enrolled tenant owns.
        self.provider.add(SHARD_1, "otherfolderxxxxxxxxxxxx/x.jpg", b"stranger " + SECRET_MARKER)
        self.recipients = {"blog": self.rec_a, "shop": self.rec_b}
        self.folders = {
            "blog": weekly.FolderEntry("blog", SHARD_1, FOLDER_A, False),
            "shop": weekly.FolderEntry("shop", SHARD_2, FOLDER_B, False),
        }
        self.config = weekly.Config(
            live_endpoint="live.example.test",
            live_region="fsn1",
            live_access_key="LIVEKEYID",
            live_secret_key="livesecret",
            backup_endpoint="backup.example.test",
            backup_region="nbg1",
            backup_bucket=BACKUP,
            backup_access_key="BACKUPKEYID",
            backup_secret_key="backupsecret",
            signing_key_file=str(self.key),
            max_requests_per_second=100.0,
        )

    def _run(self, **kw: Any) -> weekly.RunSummary:
        pacer = _pacer()
        return weekly.run(
            self.config, self.recipients, self.folders, pacer=pacer, transport=_quick_transport(self.provider, pacer), **kw
        )

    def _decrypt(self, identity: str, data: bytes) -> subprocess.CompletedProcess[bytes]:
        path = self.dir / "identity"
        path.write_text(identity)
        return subprocess.run(["age", "--decrypt", "-i", str(path)], input=data, capture_output=True)

    def test_one_dated_copy_per_tenant_with_a_manifest_each(self) -> None:
        summary = self._run()
        self.assertEqual(summary.failed, 0)
        for tenant in ("blog", "shop"):
            manifests = [k for k in self.provider.backup if k.startswith(f"media/{tenant}/generations/") and k.endswith("/manifest.json.age")]
            self.assertEqual(len(manifests), 1, tenant)
        self.assertEqual([r.objects for r in summary.results], [2, 1])
        self.assertTrue(all(r.manifest_key in self.provider.backup for r in summary.results))

    def test_reads_only_each_tenants_own_folder(self) -> None:
        self._run()
        self.assertIn((SHARD_1, FOLDER_A + "/"), self.provider.listed)
        self.assertIn((SHARD_2, FOLDER_B + "/"), self.provider.listed)
        for bucket, key in self.provider.fetched:
            self.assertTrue(key.startswith(FOLDER_A + "/") or key.startswith(FOLDER_B + "/"), key)
        self.assertNotIn((SHARD_1, "otherfolderxxxxxxxxxxxx/x.jpg"), self.provider.fetched)

    def test_each_tenants_copy_opens_with_its_own_identity_and_no_other(self) -> None:
        self._run()
        for tenant, own, other in (("blog", self.id_a, self.id_b), ("shop", self.id_b, self.id_a)):
            for key, data in self.provider.backup.items():
                if not key.startswith(f"media/{tenant}/"):
                    continue
                self.assertEqual(self._decrypt(own, data).returncode, 0, key)
                self.assertNotEqual(self._decrypt(other, data).returncode, 0, key)

    def test_no_request_to_the_backup_bucket_carries_plaintext(self) -> None:
        self._run()
        self.assertTrue(self.provider.backup)
        for key, data in self.provider.backup.items():
            self.assertNotIn(SECRET_MARKER, data, key)
            self.assertEqual(mbr.count_age_recipient_stanzas(data), 1, key)

    def test_nothing_is_written_to_disk_in_the_clear(self) -> None:
        scratch = self.dir / "scratch"
        scratch.mkdir()
        with mock.patch.dict(os.environ, {"TMPDIR": str(scratch)}), mock.patch.object(tempfile, "tempdir", str(scratch)):
            self._run()
        for path in self.dir.rglob("*"):
            if path.is_file():
                self.assertNotIn(SECRET_MARKER, path.read_bytes(), str(path))

    def test_the_copy_lands_in_the_backup_bucket_at_the_backup_endpoint(self) -> None:
        seen: list[str] = []
        real = mbr.backup_tenant_media

        def spy(**kw: Any) -> Any:
            seen.append(f"{kw['endpoint']}|{kw['backup_endpoint']}|{kw['live_bucket']}|{kw['backup_bucket']}")
            return real(**kw)

        with mock.patch.object(mbr, "backup_tenant_media", spy):
            self._run()
        self.assertEqual(seen[0], f"live.example.test|backup.example.test|{SHARD_1}|{BACKUP}")

    def test_a_tenant_that_fails_does_not_stop_the_others(self) -> None:
        del self.provider.live[(SHARD_1, f"{FOLDER_A}/2026/01/a.jpg")]
        del self.provider.live[(SHARD_1, f"{FOLDER_A}/2026/01/b.jpg")]
        summary = self._run()
        self.assertEqual([(r.tenant, r.ok) for r in summary.results], [("blog", False), ("shop", True)])
        self.assertIn("zero objects", summary.results[0].reason)

    def test_an_empty_folder_is_only_accepted_when_the_operator_says_so(self) -> None:
        del self.provider.live[(SHARD_2, f"{FOLDER_B}/2026/02/c.jpg")]
        self.assertFalse(self._run().results[1].ok)
        self.folders["shop"] = weekly.FolderEntry("shop", SHARD_2, FOLDER_B, True)
        self.assertTrue(self._run().results[1].ok)

    def test_a_tenant_with_a_recipient_and_no_folder_fails_and_reads_nothing(self) -> None:
        del self.folders["shop"]
        summary = self._run()
        self.assertEqual([(r.tenant, r.ok) for r in summary.results], [("blog", True), ("shop", False)])
        self.assertFalse(any(key.startswith(FOLDER_B) for _b, key in self.provider.fetched))

    def test_the_report_names_duration_requests_and_slowdowns(self) -> None:
        text = "\n".join(weekly.report_lines(self._run()))
        for needle in ("duration_seconds=", "requests=", "slowdowns=0", "ceiling_rps=100", "tenant=blog ok", "tenant=shop ok"):
            self.assertIn(needle, text)

    def test_sustained_slowdown_slows_the_run_and_is_counted(self) -> None:
        self.provider.statuses = [503] * 5
        pacer = _pacer(100.0)
        summary = weekly.run(self.config, self.recipients, self.folders, pacer=pacer, transport=_quick_transport(self.provider, pacer))
        self.assertEqual(summary.failed, 0)
        self.assertEqual(summary.slowdowns, 5)
        self.assertLess(pacer.rate, 100.0)

    def test_a_slowdown_that_never_clears_fails_that_tenant_not_the_run(self) -> None:
        self.provider.statuses = [503] * weekly.MAX_ATTEMPTS
        summary = self._run()
        self.assertFalse(summary.results[0].ok)
        self.assertIn("503", summary.results[0].reason)
        self.assertTrue(summary.results[1].ok)

    def test_an_encryptor_that_returns_the_plaintext_writes_nothing(self) -> None:
        """The sabotage proof: `age` handed the data back unchanged, so the run
        must refuse every tenant and put nothing in the backup bucket."""

        def passthrough(*, data: bytes, recipient: str) -> bytes:
            return data

        with mock.patch.dict(mbr.backup_tenant_media.__kwdefaults__, {"encrypt": passthrough}):
            summary = self._run()
        self.assertEqual(summary.failed, 2)
        self.assertEqual(self.provider.backup, {})

    def test_a_run_refuses_two_tenants_on_one_recipient_and_reads_nothing(self) -> None:
        self.recipients["shop"] = self.rec_a
        with self.assertRaisesRegex(weekly.WeeklyConfigError, "share one recipient"):
            self._run()
        self.assertEqual((self.provider.fetched, self.provider.listed, self.provider.backup), ([], [], {}))

    def test_two_tenants_on_one_recipient_are_refused_before_anything_is_read(self) -> None:
        file = self.dir / "recipients"
        file.write_text(f"blog {self.rec_a}\nshop {self.rec_a}\n")
        with self.assertRaisesRegex(backup_recipients.RecipientError, "share one recipient"):
            backup_recipients.load_recipients(str(file))
        self.assertEqual(self.provider.fetched, [])


class FoldersTests(unittest.TestCase):
    def test_parses_lines_and_the_no_media_mark(self) -> None:
        got = weekly.parse_folders(f"# c\nblog {SHARD_1} {FOLDER_A}\nshop {SHARD_2} {FOLDER_B} no-media\n")
        self.assertEqual(got["blog"], weekly.FolderEntry("blog", SHARD_1, FOLDER_A, False))
        self.assertTrue(got["shop"].confirm_no_media)

    def test_refuses_bad_lines(self) -> None:
        for line in (
            f"blog {SHARD_1}",
            f"blog {SHARD_1} {FOLDER_A} yes",
            f"Blog {SHARD_1} {FOLDER_A}",
            f"blog {SHARD_1} short",
            f"blog {SHARD_1} {FOLDER_A}/nested",
            f"blog UPPER {FOLDER_A}",
        ):
            with self.assertRaises(weekly.WeeklyConfigError, msg=line):
                weekly.parse_folders(line + "\n")

    def test_refuses_a_tenant_twice_and_a_folder_claimed_by_two_tenants(self) -> None:
        with self.assertRaisesRegex(weekly.WeeklyConfigError, "more than once"):
            weekly.parse_folders(f"blog {SHARD_1} {FOLDER_A}\nblog {SHARD_1} {FOLDER_B}\n")
        with self.assertRaisesRegex(weekly.WeeklyConfigError, "same folder"):
            weekly.parse_folders(f"blog {SHARD_1} {FOLDER_A}\nshop {SHARD_1} {FOLDER_A}\n")

    def test_the_same_folder_name_on_another_shard_is_another_folder(self) -> None:
        self.assertEqual(len(weekly.parse_folders(f"blog {SHARD_1} {FOLDER_A}\nshop {SHARD_2} {FOLDER_A}\n")), 2)

    def test_does_not_follow_a_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp, "real")
            target.write_text(f"blog {SHARD_1} {FOLDER_A}\n")
            link = pathlib.Path(tmp, "link")
            link.symlink_to(target)
            with self.assertRaises(weekly.WeeklyConfigError):
                weekly.load_folders(str(link))


def _env(**over: str) -> dict[str, str]:
    env = {
        "MEDIA_LIVE_ENDPOINT": "live.example.test",
        "MEDIA_LIVE_REGION": "fsn1",
        "MEDIA_LIVE_ACCESS_KEY_ID": "LIVEKEYID",
        "MEDIA_LIVE_SECRET_ACCESS_KEY": "livesecret",
        "MEDIA_BACKUP_ENDPOINT": "backup.example.test",
        "MEDIA_BACKUP_REGION": "nbg1",
        "MEDIA_BACKUP_BUCKET": BACKUP,
        "MEDIA_BACKUP_ACCESS_KEY_ID": "BACKUPKEYID",
        "MEDIA_BACKUP_SECRET_ACCESS_KEY": "backupsecret",
        "MEDIA_BACKUP_MANIFEST_SIGNING_KEY_FILE": "/nonexistent/key",
        "MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND": "100",
    }
    env.update(over)
    return env


class ConfigTests(unittest.TestCase):
    def test_a_complete_environment_parses(self) -> None:
        self.assertEqual(weekly.config_from_env(_env()).max_requests_per_second, 100.0)

    def test_every_name_is_required_and_the_refusal_names_names_not_values(self) -> None:
        for name in weekly.ENV_NAMES:
            env = _env()
            del env[name]
            with self.assertRaises(weekly.WeeklyConfigError) as ctx:
                weekly.config_from_env(env)
            self.assertIn(name, str(ctx.exception))
            self.assertNotIn("livesecret", str(ctx.exception))

    def test_the_ceiling_is_held_well_below_the_providers_750(self) -> None:
        for rate in ("0", "0.5", "401", "750", "1000", "abc", "nan"):
            with self.assertRaises(weekly.WeeklyConfigError, msg=rate):
                weekly.config_from_env(_env(MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND=rate))
        self.assertEqual(weekly.config_from_env(_env(MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND="400")).max_requests_per_second, 400.0)

    def test_a_media_bucket_is_never_the_backup_bucket(self) -> None:
        with self.assertRaisesRegex(weekly.WeeklyConfigError, "media bucket"):
            weekly.config_from_env(_env(MEDIA_BACKUP_BUCKET="shared-media-1"))

    def test_the_secrets_are_not_in_the_repr(self) -> None:
        text = repr(weekly.config_from_env(_env()))
        self.assertNotIn("livesecret", text)
        self.assertNotIn("backupsecret", text)

    def test_the_backup_bucket_may_not_also_be_a_live_bucket(self) -> None:
        config = weekly.config_from_env(_env(MEDIA_BACKUP_ENDPOINT="live.example.test", MEDIA_BACKUP_BUCKET=SHARD_1))
        with tempfile.NamedTemporaryFile() as key:
            config = weekly.Config(**{**config.__dict__, "signing_key_file": key.name})
            folders = {"blog": weekly.FolderEntry("blog", SHARD_1, FOLDER_A, False)}
            with self.assertRaisesRegex(weekly.WeeklyConfigError, "also a live"):
                weekly.check_plan(config, {"blog": "age1" + "q" * 58}, folders)

    def test_no_tenants_is_refused(self) -> None:
        with tempfile.NamedTemporaryFile() as key:
            config = weekly.Config(**{**weekly.config_from_env(_env()).__dict__, "signing_key_file": key.name})
            with self.assertRaisesRegex(weekly.WeeklyConfigError, "no tenant"):
                weekly.check_plan(config, {}, {})


class PacerTests(unittest.TestCase):
    def _pacer(self, rate: float, **kw: Any) -> tuple[weekly.RequestPacer, list[float]]:
        now = [0.0]
        slept: list[float] = []

        def sleep(seconds: float) -> None:
            slept.append(seconds)
            now[0] += seconds

        return weekly.RequestPacer(ceiling=rate, clock=lambda: now[0], sleep=sleep, **kw), slept

    def test_a_burst_is_spaced_to_the_ceiling(self) -> None:
        pacer, slept = self._pacer(10.0)
        for _ in range(11):
            pacer.wait()
        self.assertAlmostEqual(sum(slept), 1.0)  # 11 requests at 10 a second take one second after the first

    def test_slowdown_halves_the_rate_down_to_the_floor_and_counts(self) -> None:
        pacer, _ = self._pacer(8.0)
        for _ in range(6):
            pacer.record_slowdown()
        self.assertEqual(pacer.rate, weekly.FLOOR_REQUESTS_PER_SECOND)
        self.assertEqual(pacer.slowdowns, 6)

    def test_the_rate_recovers_slowly_and_never_passes_the_ceiling(self) -> None:
        pacer, _ = self._pacer(8.0, recover_after=3)
        pacer.record_slowdown()
        self.assertEqual(pacer.rate, 4.0)
        for _ in range(3):
            pacer.record_success()
        self.assertEqual(pacer.rate, 5.0)
        for _ in range(300):
            pacer.record_success()
        self.assertEqual(pacer.rate, 8.0)

    def test_a_ceiling_above_the_hard_limit_is_refused(self) -> None:
        with self.assertRaises(weekly.WeeklyConfigError):
            weekly.RequestPacer(ceiling=750.0)


class TransportTests(unittest.TestCase):
    def test_a_503_is_retried_with_backoff_and_only_a_503(self) -> None:
        pacer = _pacer()
        slept: list[float] = []
        answers = iter([(503, b""), (503, b""), (200, b"ok")])
        transport = weekly.PacedTransport(pacer, sleep=slept.append, jitter=lambda: 1.0, get=lambda u, h: next(answers))
        self.assertEqual(transport.get("u", {}), (200, b"ok"))
        self.assertEqual(slept, [1.0, 2.0])
        self.assertEqual((pacer.requests, pacer.slowdowns), (3, 2))
        calls: list[int] = []
        transport = weekly.PacedTransport(pacer, sleep=slept.append, get=lambda u, h: (calls.append(1), (403, b""))[1])
        self.assertEqual(transport.get("u", {})[0], 403)
        self.assertEqual(len(calls), 1)

    def test_the_backoff_is_capped(self) -> None:
        slept: list[float] = []
        transport = weekly.PacedTransport(_pacer(), sleep=slept.append, jitter=lambda: 1.0, get=lambda u, h: (503, b""))
        self.assertEqual(transport.get("u", {})[0], 503)
        self.assertEqual(max(slept), 60.0)
        self.assertEqual(len(slept), weekly.MAX_ATTEMPTS - 1)


@unittest.skipUnless(TOOLS, "age, age-keygen and ssh-keygen are needed")
class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        self.key = self.dir / "signing"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.key)], check=True)
        _, rec = _identity()
        self.recipients = self.dir / "recipients"
        self.recipients.write_text(f"blog {rec}\n")
        self.folders = self.dir / "folders"
        self.folders.write_text(f"blog {SHARD_1} {FOLDER_A}\n")
        self.env = _env(MEDIA_BACKUP_MANIFEST_SIGNING_KEY_FILE=str(self.key))

    def _main(self, *extra: str, env: dict[str, str] | None = None) -> int:
        return weekly.main(["--recipients-file", str(self.recipients), "--folders-file", str(self.folders), *extra], env=env or self.env)

    def test_check_touches_no_bucket(self) -> None:
        with mock.patch.object(shared, "list_objects", side_effect=AssertionError("network")):
            self.assertEqual(self._main("--check"), 0)

    def test_check_refuses_a_missing_setting_with_exit_2(self) -> None:
        env = dict(self.env)
        del env["MEDIA_BACKUP_BUCKET"]
        self.assertEqual(self._main("--check", env=env), 2)

    def test_two_tenants_on_one_recipient_refuse_the_run(self) -> None:
        rec = self.recipients.read_text().split()[1]
        self.recipients.write_text(f"blog {rec}\nshop {rec}\n")
        with mock.patch.object(shared, "list_objects", side_effect=AssertionError("network")):
            self.assertEqual(self._main(), 2)


if __name__ == "__main__":
    unittest.main()

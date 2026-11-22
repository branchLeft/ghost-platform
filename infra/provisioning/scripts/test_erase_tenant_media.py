#!/usr/bin/env python3
"""Tests for erase_tenant_media.py against fake shards that keep several
versions and delete markers per object, a fake gateway admin, and the gateway's
real write-ledger schema in a real SQLite file. No credential, bucket or
gateway is used. See test_erase_tenant_media.md.
"""

from __future__ import annotations

import base64
import http.server
import json
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from collections.abc import Callable
from typing import Any

import erase_tenant_media as em

HERE = pathlib.Path(__file__).resolve().parent
LEDGER_SCHEMA = HERE.parents[2] / "services" / "storage-gateway" / "drizzle" / "usage" / "0000_usage_ledger.sql"

BUCKET = "shard-one"
FOLDER_A = "folderaaaaaaaaaa1"
FOLDER_B = "folderbbbbbbbbbb2"
# Another tenant whose folder starts with FOLDER_A's whole name.
FOLDER_LONG = FOLDER_A + "-extended"
FOLDER_SHORT = FOLDER_A[:16]  # a prefix of FOLDER_A, itself a valid folder name

REGISTER = [
    em.RegisteredTenant("tenant-a", FOLDER_A, BUCKET),
    em.RegisteredTenant("tenant-b", FOLDER_B, BUCKET),
    em.RegisteredTenant("tenant-long", FOLDER_LONG, BUCKET),
]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class FakeShard:
    """A versioned shard: each key holds a list of (version id, kind)."""

    def __init__(self) -> None:
        self.objects: dict[str, list[tuple[str, str]]] = {}
        self.deleted: list[em.ObjectVersion] = []
        self.listings = 0
        self.slowdowns_left = 0
        self.fail_delete_with: em.StoreError | None = None
        self.resurrect_once = False
        self._counter = 0

    def put(self, key: str, versions: int = 3, marker: bool = False) -> None:
        entries = self.objects.setdefault(key, [])
        for _ in range(versions):
            self._counter += 1
            entries.append((f"v{self._counter}", "version"))
        if marker:
            self._counter += 1
            entries.append((f"m{self._counter}", "delete_marker"))

    def keys_under(self, prefix: str) -> list[str]:
        return sorted(key for key in self.objects if key.startswith(prefix))

    def list_versions(self, prefix: str) -> list[em.ObjectVersion]:
        self.listings += 1
        return [
            em.ObjectVersion(key, vid, kind)
            for key, entries in sorted(self.objects.items())
            if key.startswith(prefix)
            for vid, kind in entries
        ]

    def delete_version(self, version: em.ObjectVersion) -> None:
        if self.slowdowns_left > 0:
            self.slowdowns_left -= 1
            raise em.StoreError("slow down", 503)
        if self.fail_delete_with is not None:
            raise self.fail_delete_with
        entries = self.objects.get(version.key, [])
        entries[:] = [e for e in entries if e[0] != version.version_id]
        if not entries:
            self.objects.pop(version.key, None)
        self.deleted.append(version)


class FakeAdmin:
    def __init__(self, register: list[em.RegisteredTenant]) -> None:
        self.register = register
        self.calls: list[str] = []
        self.leave_active = False
        self.wrong_bucket = False

    def disable_folder(self, folder: str) -> list[em.GatewayCredential]:
        self.calls.append(folder)
        match = [t for t in self.register if t.folder == folder]
        if not match:
            raise em.Refusal("the gateway knows no credential for the folder; nothing changed")
        bucket = "elsewhere" if self.wrong_bucket else match[0].bucket
        state = "active" if self.leave_active else "disabled"
        return [em.GatewayCredential("GWKEY1", folder, bucket, state)]


class FakeEdge:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.purged: list[str] = []
        self.ready = True

    def check_ready(self) -> None:
        if not self.ready:
            raise em.Refusal("edge not ready; nothing changed")

    def purge_folder(self, folder: str) -> None:
        self.events.append("purge")
        self.purged.append(folder)


class FakeBackup:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.erased: list[str] = []

    def erase(self, tenant_id: str) -> None:
        self.events.append("backup")
        self.erased.append(tenant_id)


class MediaCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.journal = self.tmp / "journal"
        self.journal.mkdir()
        self.ledger_path = self.tmp / "ledger.sqlite"
        db = sqlite3.connect(self.ledger_path)
        db.executescript(LEDGER_SCHEMA.read_text().replace("--> statement-breakpoint", ""))
        db.commit()
        db.close()
        self.shard = FakeShard()
        self.admin = FakeAdmin(REGISTER)
        self.events: list[str] = []
        self.edge = FakeEdge(self.events)
        self.backup = FakeBackup(self.events)
        self.time = FakeClock()

    # -- helpers -----------------------------------------------------------

    def record(self, folder: str, name: str) -> None:
        """What the gateway does for a write: one ledger row."""
        db = sqlite3.connect(self.ledger_path)
        db.execute(
            "INSERT INTO write_ledger (key_id, folder, bucket, object_key, size, operation, written_at) "
            "VALUES ('GWKEY1', ?, ?, ?, 10, 'PutObject', '2026-11-20T00:00:00Z')",
            (folder, BUCKET, f"{folder}/{name}"),
        )
        db.commit()
        db.close()

    def tenant_writes(self, folder: str, names: list[str], **kwargs: Any) -> None:
        """Objects on the shard and in the ledger, as a tenant working through the gateway leaves them."""
        for name in names:
            self.shard.put(f"{folder}/{name}", **kwargs)
            self.record(folder, name)

    def run_erase(self, folder: str = FOLDER_A, **overrides: Any) -> em.Report:
        kwargs: dict[str, Any] = {
            "folder": folder,
            "bucket": BUCKET,
            "register": REGISTER,
            "admin": self.admin,
            "store": self.shard,
            "ledger": em.SqliteLedgerReader(str(self.ledger_path)),
            "edge": self.edge,
            "backup": self.backup,
            "journal_dir": str(self.journal),
            "clock": self.time.clock,
            "sleep": self.time.sleep,
        }
        kwargs.update(overrides)
        return em.erase_media(**kwargs)

    def assert_nothing_deleted(self) -> None:
        self.assertEqual(self.shard.deleted, [])
        self.assertEqual(self.admin.calls, [])
        self.assertEqual(self.events, [])


class ErasureTests(MediaCase):
    def test_erases_every_version_and_marker_and_leaves_other_tenants(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png", "b.png", "dir/c.png"], versions=3, marker=True)
        self.tenant_writes(FOLDER_B, ["keep.png"])
        self.tenant_writes(FOLDER_LONG, ["neighbour.png"])
        before_b = self.shard.keys_under(FOLDER_B + "/")
        before_long = list(self.shard.objects[f"{FOLDER_LONG}/neighbour.png"])

        report = self.run_erase()

        self.assertEqual(self.shard.keys_under(FOLDER_A + "/"), [])
        self.assertEqual(self.shard.keys_under(FOLDER_B + "/"), before_b)
        self.assertEqual(self.shard.objects[f"{FOLDER_LONG}/neighbour.png"], before_long)
        self.assertEqual((report.versions_deleted, report.delete_markers_deleted), (9, 3))
        self.assertEqual(report.object_names, 3)
        self.assertEqual(self.events, ["purge", "backup"])
        self.assertEqual(self.edge.purged, [FOLDER_A])
        self.assertEqual(self.backup.erased, ["tenant-a"])

    def test_disable_comes_before_any_delete(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        order: list[str] = []
        original = self.shard.delete_version

        def delete(version: em.ObjectVersion) -> None:
            order.append("delete")
            original(version)

        self.shard.delete_version = delete  # type: ignore[method-assign]
        calls = self.admin.disable_folder

        def disable(folder: str) -> list[em.GatewayCredential]:
            order.append("disable")
            return calls(folder)

        self.admin.disable_folder = disable  # type: ignore[method-assign]
        self.run_erase()
        self.assertEqual(order[0], "disable")
        self.assertEqual(order.count("disable"), 1)

    def test_tenant_that_wrote_nothing_is_green(self) -> None:
        report = self.run_erase()
        self.assertEqual((report.versions_deleted, report.object_names), (0, 0))

    def test_rounds_continue_until_a_listing_is_empty(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        original = self.shard.list_versions
        state = {"first": True}

        def listing(prefix: str) -> list[em.ObjectVersion]:
            found = original(prefix)
            if not state["first"] and self.shard.keys_under(FOLDER_A + "/") == []:
                return found
            if state["first"]:
                state["first"] = False
                # A late write lands between the first listing and the delete.
                self.shard.put(f"{FOLDER_A}/late.png", versions=1)
                self.record(FOLDER_A, "late.png")
            return found

        self.shard.list_versions = listing  # type: ignore[method-assign]
        report = self.run_erase()
        self.assertGreaterEqual(report.rounds, 2)
        self.assertEqual(self.shard.keys_under(FOLDER_A + "/"), [])

    def test_a_shard_that_keeps_giving_versions_is_red(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        original = self.shard.delete_version

        def delete(version: em.ObjectVersion) -> None:
            original(version)
            self.shard.put(version.key, versions=1)  # something keeps writing

        self.shard.delete_version = delete  # type: ignore[method-assign]
        with self.assertRaises(em.RedCheck):
            self.run_erase()
        self.assertEqual(self.events, [])

    def test_report_gives_requests_and_duration(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"], versions=2)
        report = self.run_erase()
        # Two listings that show versions and one that ends the loop, then the check's listing, plus deletes.
        self.assertEqual(report.requests, 2 + 3)
        self.assertGreater(report.seconds, 0)


class SabotageTests(MediaCase):
    """The completeness check goes red for a plant in either direction, and green once the plant is gone."""

    def test_object_in_the_folder_but_not_in_the_ledger_is_red(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.shard.put(f"{FOLDER_A}/planted.png", versions=1)  # on the shard, never recorded
        with self.assertRaises(em.RedCheck) as caught:
            self.run_erase()
        self.assertIn("not in the ledger", str(caught.exception))
        self.assertEqual(self.shard.deleted, [], "a plant found before the first delete stops the run")
        self.assertEqual(self.events, [], "the edge purge and backup erasure must not run after a red check")

    def test_ledger_entry_the_listing_does_not_show_is_red(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.record(FOLDER_A, "ghost.png")  # recorded, never on the shard
        with self.assertRaises(em.RedCheck):
            self.run_erase()
        self.assertEqual(self.events, [])

    def test_removing_the_plants_is_green(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.run_erase()
        self.assertEqual(self.events, ["purge", "backup"])

    def test_a_ledger_name_outside_the_folder_is_red(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        db = sqlite3.connect(self.ledger_path)
        db.execute(
            "INSERT INTO write_ledger (key_id, folder, bucket, object_key, size, operation, written_at) "
            f"VALUES ('GWKEY1', '{FOLDER_A}', '{BUCKET}', '{FOLDER_B}/x.png', 1, 'PutObject', 'now')"
        )
        db.commit()
        db.close()
        with self.assertRaises(em.RedCheck):
            self.run_erase()

    def test_an_empty_ledger_for_a_folder_with_objects_is_red(self) -> None:
        self.shard.put(f"{FOLDER_A}/a.png")
        with self.assertRaises(em.RedCheck):
            self.run_erase()

    def test_a_prefix_of_another_tenants_folder_refuses_and_touches_nothing(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.tenant_writes(FOLDER_LONG, ["neighbour.png"])
        with self.assertRaises(em.Refusal) as caught:
            self.run_erase(folder=FOLDER_SHORT)
        self.assertIn("prefix of another tenant's folder", str(caught.exception))
        self.assert_nothing_deleted()
        self.assertEqual(len(self.shard.keys_under(FOLDER_A + "/")), 1)

    def test_a_prefix_that_is_a_valid_registered_folder_cannot_reach_the_longer_one(self) -> None:
        # FOLDER_A is registered and FOLDER_LONG starts with it: listing is by "folder/".
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.tenant_writes(FOLDER_LONG, ["neighbour.png"])
        self.run_erase(folder=FOLDER_A)
        self.assertEqual(self.shard.keys_under(FOLDER_LONG + "/"), [f"{FOLDER_LONG}/neighbour.png"])

    def test_the_job_checks_every_listed_key_is_inside_the_folder(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        original = self.shard.list_versions

        def broken(prefix: str) -> list[em.ObjectVersion]:
            return original("") if prefix == FOLDER_A + "/" else original(prefix)

        self.shard.list_versions = broken  # type: ignore[method-assign]
        self.tenant_writes(FOLDER_B, ["other.png"])
        with self.assertRaises(em.RedCheck):
            self.run_erase()
        self.assertEqual(self.shard.deleted, [])


class RefusalTests(MediaCase):
    def test_unregistered_folder_refuses(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        with self.assertRaises(em.Refusal):
            self.run_erase(folder="unregistered-folder-9")
        self.assert_nothing_deleted()

    def test_malformed_folder_refuses(self) -> None:
        for folder in ["", "short", "../" + FOLDER_A, FOLDER_A + "/", "a" * 129, FOLDER_A + " "]:
            with self.subTest(folder=folder), self.assertRaises(em.Refusal):
                self.run_erase(folder=folder)
        self.assert_nothing_deleted()

    def test_wrong_bucket_refuses(self) -> None:
        with self.assertRaises(em.Refusal):
            self.run_erase(bucket="shard-two")
        self.assert_nothing_deleted()

    def test_register_listing_a_folder_twice_refuses(self) -> None:
        doubled = [*REGISTER, em.RegisteredTenant("other", FOLDER_A, BUCKET)]
        with self.assertRaises(em.Refusal):
            self.run_erase(register=doubled)
        self.assert_nothing_deleted()

    def test_edge_not_ready_refuses_before_any_change(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.edge.ready = False
        with self.assertRaises(em.Refusal):
            self.run_erase()
        self.assert_nothing_deleted()

    def test_a_credential_left_active_stops_before_any_delete(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.admin.leave_active = True
        with self.assertRaises(em.RedCheck):
            self.run_erase()
        self.assertEqual(self.shard.deleted, [])

    def test_a_credential_for_another_bucket_stops_before_any_delete(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.admin.wrong_bucket = True
        with self.assertRaises(em.RedCheck):
            self.run_erase()
        self.assertEqual(self.shard.deleted, [])

    def test_missing_journal_directory_refuses(self) -> None:
        with self.assertRaises(em.Refusal):
            self.run_erase(journal_dir=str(self.tmp / "absent"))
        self.assert_nothing_deleted()

    def test_ceiling_above_the_hard_limit_refuses(self) -> None:
        for rate in (0.0, -1.0, em.HARD_MAX_RPS + 1, 750.0):
            with self.subTest(rate=rate), self.assertRaises(em.Refusal):
                self.run_erase(max_rps=rate)
        self.assert_nothing_deleted()


class PacingTests(MediaCase):
    def test_requests_never_exceed_the_ceiling(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png", "b.png"], versions=5)
        stamps: list[float] = []
        original = self.shard.delete_version

        def delete(version: em.ObjectVersion) -> None:
            stamps.append(self.time.now)
            original(version)

        self.shard.delete_version = delete  # type: ignore[method-assign]
        self.run_erase(max_rps=10.0)
        gaps = [later - earlier for earlier, later in zip(stamps, stamps[1:])]
        self.assertTrue(all(gap >= 0.1 - 1e-9 for gap in gaps), gaps)

    def test_slowdown_is_retried_with_a_doubling_backoff(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"], versions=1)
        self.shard.slowdowns_left = 3
        report = self.run_erase()
        self.assertEqual(report.slowdowns, 3)
        backoffs = [s for s in self.time.sleeps if s >= em.BACKOFF_START_SECONDS]
        self.assertEqual(backoffs[:3], [0.5, 1.0, 2.0])
        self.assertEqual(self.shard.keys_under(FOLDER_A + "/"), [])

    def test_a_slowdown_that_never_clears_is_an_error(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"], versions=1)
        self.shard.slowdowns_left = 10_000
        with self.assertRaises(em.StoreError):
            self.run_erase()
        self.assertEqual(self.events, [])

    def test_other_failures_are_not_retried(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"], versions=2)
        self.shard.fail_delete_with = em.StoreError("denied", 403)
        with self.assertRaises(em.StoreError):
            self.run_erase()
        self.assertEqual(self.shard.deleted, [])

    def test_backoff_is_capped(self) -> None:
        store = em.PacedStore(
            self.shard,
            em.Pacer(100.0, clock=self.time.clock, sleep=self.time.sleep),
            em.RunCounts(),
            sleep=self.time.sleep,
        )
        self.shard.slowdowns_left = em.MAX_ATTEMPTS - 1
        store.delete_version(em.ObjectVersion("k", "v", "version"))
        self.assertLessEqual(max(self.time.sleeps), em.BACKOFF_CAP_SECONDS)


class JournalTests(MediaCase):
    def test_a_run_again_after_a_late_failure_is_still_checked_against_the_ledger(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png", "b.png"])
        self.edge.ready = True
        original = self.edge.purge_folder

        def failing(folder: str) -> None:
            raise em.RedCheck("purge failed")

        self.edge.purge_folder = failing  # type: ignore[method-assign]
        with self.assertRaises(em.RedCheck):
            self.run_erase()
        self.assertEqual(self.shard.keys_under(FOLDER_A + "/"), [])
        self.edge.purge_folder = original  # type: ignore[method-assign]

        report = self.run_erase()
        self.assertEqual(report.object_names, 2)
        self.assertEqual(self.events, ["purge", "backup"])

    def test_a_planted_ledger_entry_is_still_red_on_a_run_again(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.run_erase()
        self.record(FOLDER_A, "ghost.png")
        with self.assertRaises(em.RedCheck):
            self.run_erase()

    def test_malformed_journal_refuses(self) -> None:
        (self.journal / f"media-erasure-{FOLDER_A}.json").write_text("{not json")
        with self.assertRaises(em.Refusal):
            self.run_erase()
        self.assert_nothing_deleted()

    def test_journal_is_written_before_the_first_delete(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        seen: list[set[str]] = []
        original = self.shard.delete_version

        def delete(version: em.ObjectVersion) -> None:
            seen.append(em.read_journal(str(self.journal), FOLDER_A))
            original(version)

        self.shard.delete_version = delete  # type: ignore[method-assign]
        self.run_erase()
        self.assertEqual(seen[0], {f"{FOLDER_A}/a.png"})


class RegisterTests(unittest.TestCase):
    def write(self, text: str) -> str:
        directory = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        path = directory / "register.json"
        path.write_text(text)
        return str(path)

    def test_reads_entries(self) -> None:
        path = self.write(json.dumps({"entries": [{"tenantId": "t", "mediaFolder": FOLDER_A, "mediaBucket": BUCKET, "x": 1}]}))
        self.assertEqual(em.read_register(path), [em.RegisteredTenant("t", FOLDER_A, BUCKET)])

    def test_malformed_registers_refuse(self) -> None:
        for text in ["", "[]", "{}", '{"entries": [1]}', '{"entries": [{"tenantId": "t"}]}', '{"entries": [{"tenantId": "t", "mediaFolder": "", "mediaBucket": "b"}]}']:
            with self.subTest(text=text), self.assertRaises(em.Refusal):
                em.read_register(self.write(text))

    def test_missing_register_refuses(self) -> None:
        with self.assertRaises(em.Refusal):
            em.read_register("/nonexistent/register.json")


class LedgerReaderTests(MediaCase):
    def test_reads_only_the_folders_names(self) -> None:
        self.record(FOLDER_A, "a.png")
        self.record(FOLDER_B, "b.png")
        self.assertEqual(em.SqliteLedgerReader(str(self.ledger_path)).object_keys(FOLDER_A), {f"{FOLDER_A}/a.png"})

    def test_missing_file_refuses(self) -> None:
        with self.assertRaises(em.Refusal):
            em.SqliteLedgerReader(str(self.tmp / "nope.sqlite"))

    def test_a_file_that_is_not_a_ledger_is_red(self) -> None:
        other = self.tmp / "other.sqlite"
        sqlite3.connect(other).close()
        with self.assertRaises(em.RedCheck):
            em.SqliteLedgerReader(str(other)).object_keys(FOLDER_A)

    def test_reading_never_changes_the_ledger(self) -> None:
        self.record(FOLDER_A, "a.png")
        before = self.ledger_path.read_bytes()
        em.SqliteLedgerReader(str(self.ledger_path)).object_keys(FOLDER_A)
        self.assertEqual(self.ledger_path.read_bytes(), before)


XML_NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'


class FakeSigned:
    """Stands in for the repository's SigV4 module: records requests, answers from a script."""

    def __init__(self, answers: list[tuple[int, bytes]]) -> None:
        self.answers = answers
        self.requests: list[dict[str, Any]] = []

    def signed_request(self, **kwargs: Any) -> tuple[int, bytes]:
        self.requests.append(kwargs)
        return self.answers.pop(0)


def page(entries: str, truncated: bool = False, key_marker: str = "", version_marker: str = "") -> bytes:
    more = f"<NextKeyMarker>{key_marker}</NextKeyMarker><NextVersionIdMarker>{version_marker}</NextVersionIdMarker>" if truncated else ""
    return f"<ListVersionsResult {XML_NS}><IsTruncated>{str(truncated).lower()}</IsTruncated>{more}{entries}</ListVersionsResult>".encode()


class S3StoreTests(unittest.TestCase):
    ACCESS = em.ShardAccess(BUCKET, "endpoint.example", "region-1", "KEYID", "SECRET")

    def test_lists_versions_and_markers_across_pages(self) -> None:
        first = page(
            "<Version><Key>f/a</Key><VersionId>1</VersionId></Version><DeleteMarker><Key>f/a</Key><VersionId>2</VersionId></DeleteMarker>",
            truncated=True,
            key_marker="f/a",
            version_marker="2",
        )
        second = page("<Version><Key>f/b</Key><VersionId>3</VersionId></Version>")
        signed = FakeSigned([(200, first), (200, second)])
        found = em.S3MediaStore(self.ACCESS, signed).list_versions("f/")
        self.assertEqual(
            found,
            [em.ObjectVersion("f/a", "1", "version"), em.ObjectVersion("f/a", "2", "delete_marker"), em.ObjectVersion("f/b", "3", "version")],
        )
        self.assertEqual(signed.requests[0]["query"], {"versions": "", "prefix": "f/"})
        self.assertEqual(signed.requests[1]["query"]["key-marker"], "f/a")
        self.assertEqual(signed.requests[1]["query"]["version-id-marker"], "2")

    def test_truncated_with_no_marker_is_an_error_not_a_short_answer(self) -> None:
        signed = FakeSigned([(200, page("<Version><Key>f/a</Key><VersionId>1</VersionId></Version>", truncated=True))])
        with self.assertRaises(em.StoreError):
            em.S3MediaStore(self.ACCESS, signed).list_versions("f/")

    def test_failed_listing_carries_the_status(self) -> None:
        with self.assertRaises(em.StoreError) as caught:
            em.S3MediaStore(self.ACCESS, FakeSigned([(503, b"SlowDown")])).list_versions("f/")
        self.assertEqual(caught.exception.status, 503)

    def test_garbage_listing_is_an_error(self) -> None:
        with self.assertRaises(em.StoreError):
            em.S3MediaStore(self.ACCESS, FakeSigned([(200, b"<not")])).list_versions("f/")

    def test_delete_is_by_version_id(self) -> None:
        signed = FakeSigned([(204, b"")])
        em.S3MediaStore(self.ACCESS, signed).delete_version(em.ObjectVersion("f/a", "9", "version"))
        self.assertEqual((signed.requests[0]["method"], signed.requests[0]["key"], signed.requests[0]["query"]), ("DELETE", "f/a", {"versionId": "9"}))

    def test_delete_of_a_version_already_gone_is_fine_and_other_errors_carry_status(self) -> None:
        em.S3MediaStore(self.ACCESS, FakeSigned([(404, b"")])).delete_version(em.ObjectVersion("f/a", "9", "version"))
        with self.assertRaises(em.StoreError) as caught:
            em.S3MediaStore(self.ACCESS, FakeSigned([(503, b"")])).delete_version(em.ObjectVersion("f/a", "9", "version"))
        self.assertEqual(caught.exception.status, 503)

    def test_a_version_without_an_id_is_never_deleted_without_one(self) -> None:
        signed = FakeSigned([])
        with self.assertRaises(em.StoreError):
            em.S3MediaStore(self.ACCESS, signed).delete_version(em.ObjectVersion("f/a", "", "version"))
        self.assertEqual(signed.requests, [])

    def test_a_transport_failure_never_carries_the_key(self) -> None:
        class Broken:
            def signed_request(self, **kwargs: Any) -> tuple[int, bytes]:
                raise OSError("secret=SECRET")

        with self.assertRaises(em.StoreError) as caught:
            em.S3MediaStore(self.ACCESS, Broken()).list_versions("f/")
        self.assertNotIn("SECRET", str(caught.exception))
        self.assertNotIn("SECRET", repr(self.ACCESS))


class AdminTests(unittest.TestCase):
    def serve(self, status: int, body: bytes) -> tuple[str, list[dict[str, Any]]]:
        seen: list[dict[str, Any]] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                seen.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}})
                self.send_response(status)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return f"http://127.0.0.1:{server.server_port}", seen

    def test_signs_the_gateways_payload_as_the_erasure_job(self) -> None:
        answer = json.dumps(
            {"folder": FOLDER_A, "disabled": 1, "credentials": [{"keyId": "GW1", "folder": FOLDER_A, "bucket": BUCKET, "state": "disabled"}]}
        ).encode()
        url, seen = self.serve(200, answer)
        signed: list[bytes] = []

        def sign(key_file: str, payload: bytes) -> bytes:
            signed.append(payload)
            return b"\x01" * 64

        admin = em.HttpGatewayAdmin(url, "key.pem", sign=sign, now=lambda: 1_700_000_000.9)
        credentials = admin.disable_folder(FOLDER_A)

        self.assertEqual(credentials, [em.GatewayCredential("GW1", FOLDER_A, BUCKET, "disabled")])
        headers = seen[0]["headers"]
        self.assertEqual(seen[0]["path"], f"/folders/{FOLDER_A}/disable")
        self.assertEqual(headers["x-gateway-admin-caller"], "erasure-job")
        self.assertEqual(headers["x-gateway-admin-timestamp"], "1700000000")
        self.assertEqual(base64.b64decode(headers["x-gateway-admin-signature"]), b"\x01" * 64)
        expected = f"erasure-job\nPOST\n/folders/{FOLDER_A}/disable\n1700000000\n{headers['x-gateway-admin-nonce']}\n".encode()
        self.assertEqual(signed[0], expected)

    def test_unknown_folder_is_a_refusal(self) -> None:
        url, _ = self.serve(404, b'{"error":"no credential for this folder"}')
        admin = em.HttpGatewayAdmin(url, "key.pem", sign=lambda k, p: b"\x00" * 64)
        with self.assertRaises(em.Refusal):
            admin.disable_folder(FOLDER_A)

    def test_not_authorised_is_a_refusal(self) -> None:
        url, _ = self.serve(401, b"{}")
        admin = em.HttpGatewayAdmin(url, "key.pem", sign=lambda k, p: b"\x00" * 64)
        with self.assertRaises(em.Refusal):
            admin.disable_folder(FOLDER_A)

    def test_unreadable_answer_is_a_refusal(self) -> None:
        url, _ = self.serve(200, b"not json")
        admin = em.HttpGatewayAdmin(url, "key.pem", sign=lambda k, p: b"\x00" * 64)
        with self.assertRaises(em.Refusal):
            admin.disable_folder(FOLDER_A)

    def test_unreachable_gateway_is_a_refusal(self) -> None:
        admin = em.HttpGatewayAdmin("http://127.0.0.1:1", "key.pem", sign=lambda k, p: b"\x00" * 64)
        with self.assertRaises(em.Refusal):
            admin.disable_folder(FOLDER_A)


def openssl_signs_ed25519() -> bool:
    try:
        with tempfile.TemporaryDirectory() as scratch:
            key = pathlib.Path(scratch) / "k.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
            message = pathlib.Path(scratch) / "m"
            message.write_bytes(b"x")
            done = subprocess.run(
                ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(message)], capture_output=True, check=False
            )
            return done.returncode == 0 and len(done.stdout) == 64
    except (OSError, subprocess.SubprocessError):
        return False


@unittest.skipUnless(openssl_signs_ed25519(), "this openssl cannot sign Ed25519 with -rawin")
class OpensslSigningTests(unittest.TestCase):
    def test_signature_verifies_against_the_public_half(self) -> None:
        scratch = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        key, public = scratch / "k.pem", scratch / "k.pub"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(public)], check=True, capture_output=True)
        payload = em._admin_payload("erasure-job", "POST", "/folders/x/disable", "1700000000", "n" * 16, b"")
        signature = em.openssl_ed25519_sign(str(key), payload)
        (scratch / "sig").write_bytes(signature)
        (scratch / "msg").write_bytes(payload)
        verify = ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public), "-rawin", "-in", str(scratch / "msg"), "-sigfile", str(scratch / "sig")]
        self.assertEqual(subprocess.run(verify, capture_output=True, check=False).returncode, 0)
        (scratch / "msg").write_bytes(payload + b"x")
        self.assertNotEqual(subprocess.run(verify, capture_output=True, check=False).returncode, 0)

    def test_a_bad_key_file_refuses(self) -> None:
        with self.assertRaises(em.Refusal):
            em.openssl_ed25519_sign("/nonexistent.pem", b"x")


class MainTests(MediaCase):
    ARGS: Callable[[str], list[str]]

    def args(self, folder: str = FOLDER_A) -> list[str]:
        register = self.tmp / "register.json"
        register.write_text(
            json.dumps({"entries": [{"tenantId": t.tenant_id, "mediaFolder": t.folder, "mediaBucket": t.bucket} for t in REGISTER]})
        )
        return [
            "--folder", folder, "--bucket", BUCKET, "--endpoint", "endpoint.example", "--region", "r",
            "--register", str(register), "--ledger", str(self.ledger_path),
            "--gateway-admin-url", "http://127.0.0.1:1", "--admin-key-file", "k.pem",
            "--journal-dir", str(self.journal),
        ]  # fmt: skip

    def test_without_the_erasure_key_it_refuses(self) -> None:
        self.assertEqual(em.main(self.args(), env={}), em.EXIT_REFUSED)
        self.assertEqual(em.main(self.args(), env={em.ENV_ACCESS_KEY: "id"}), em.EXIT_REFUSED)

    def test_an_unregistered_folder_refuses_before_any_request(self) -> None:
        env = {em.ENV_ACCESS_KEY: "id", em.ENV_SECRET_KEY: "secret"}
        self.assertEqual(em.main(self.args("unregistered-folder-9"), env=env), em.EXIT_REFUSED)

    def test_a_prefix_of_another_tenants_folder_refuses(self) -> None:
        env = {em.ENV_ACCESS_KEY: "id", em.ENV_SECRET_KEY: "secret"}
        self.assertEqual(em.main(self.args(FOLDER_SHORT), env=env), em.EXIT_REFUSED)

    def test_with_no_edge_purge_available_it_refuses_before_any_change(self) -> None:
        env = {em.ENV_ACCESS_KEY: "id", em.ENV_SECRET_KEY: "secret"}
        self.assertEqual(em.main(self.args(), env=env), em.EXIT_REFUSED)

    def test_the_command_line_has_no_flag_for_the_key(self) -> None:
        with self.assertRaises(SystemExit):
            em.main([*self.args(), "--secret-access-key", "x"], env={})


if __name__ == "__main__":
    unittest.main()


class FollowupTests(MediaCase):
    def test_a_short_ledger_stops_before_the_first_delete(self) -> None:
        # The shard holds two objects; the ledger recorded only one of them.
        self.tenant_writes(FOLDER_A, ["recorded.png"])
        self.shard.put(f"{FOLDER_A}/unrecorded.png")
        with self.assertRaises(em.RedCheck) as caught:
            self.run_erase()
        self.assertIn("not in the ledger; nothing was deleted", str(caught.exception))
        self.assertEqual(self.shard.deleted, [])
        self.assertEqual(len(self.shard.keys_under(FOLDER_A + "/")), 2)

    def test_a_folder_with_a_trailing_newline_is_refused(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        with self.assertRaises(em.Refusal) as caught:
            self.run_erase(folder=FOLDER_A + "\n")
        self.assertIn("not a valid folder name", str(caught.exception))
        self.assert_nothing_deleted()

    def test_a_key_with_a_dot_segment_stops_before_any_delete(self) -> None:
        self.tenant_writes(FOLDER_A, ["a.png"])
        self.tenant_writes(FOLDER_A, ["sub/../b.png"])
        with self.assertRaises(em.RedCheck) as caught:
            self.run_erase()
        self.assertIn("dot path segment", str(caught.exception))
        self.assertEqual(self.shard.deleted, [])

    def test_a_ledger_path_with_query_and_fragment_characters_is_read(self) -> None:
        folder_dir = self.tmp / "odd?name#here"
        folder_dir.mkdir()
        moved = folder_dir / "ledger.sqlite"
        shutil.copy(self.ledger_path, moved)
        self.ledger_path = moved
        self.record(FOLDER_A, "a.png")
        found = em.SqliteLedgerReader(str(moved)).object_keys(FOLDER_A)
        self.assertEqual(found, {f"{FOLDER_A}/a.png"})

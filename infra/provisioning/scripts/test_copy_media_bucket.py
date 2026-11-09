#!/usr/bin/env python3
"""Unit tests for copy_media_bucket.py, against in-memory fake buckets. No network.

The source fake records every method called on it and declares no write or
delete method, so a copy that writes or deletes at the source fails here.
See copy_media_bucket.md.
"""

from __future__ import annotations

import os
import unittest
from typing import ClassVar
from unittest import mock

import copy_media_bucket as cmb

DEFAULT_TYPE = "application/octet-stream"


class MemoryBucket:
    """An in-memory bucket with list, read and write. Each object keeps its Content-Type."""

    def __init__(
        self,
        objects: dict[str, bytes] | None = None,
        content_types: dict[str, str] | None = None,
    ) -> None:
        self.objects: dict[str, bytes] = dict(objects or {})
        self.content_types: dict[str, str] = dict(content_types or {})
        self.calls: list[str] = []

    def list_keys(self, prefix: str | None) -> list[str]:
        self.calls.append("list_keys")
        return [key for key in self.objects if prefix is None or key.startswith(prefix)]

    def read(self, key: str) -> cmb.StoredObject:
        self.calls.append("read")
        return cmb.StoredObject(
            data=self.objects[key],
            content_type=self.content_types.get(key, DEFAULT_TYPE),
        )

    def write(self, key: str, obj: cmb.StoredObject) -> None:
        self.calls.append("write")
        self.objects[key] = obj.data
        self.content_types[key] = obj.content_type


class RecordingSource:
    """The source the copy is given. It declares list and read only, and records its calls."""

    def __init__(
        self,
        objects: dict[str, bytes],
        content_types: dict[str, str] | None = None,
    ) -> None:
        self._bucket = MemoryBucket(objects, content_types)

    @property
    def calls(self) -> list[str]:
        return self._bucket.calls

    def list_keys(self, prefix: str | None) -> list[str]:
        return self._bucket.list_keys(prefix)

    def read(self, key: str) -> cmb.StoredObject:
        return self._bucket.read(key)


class CorruptingDestination(MemoryBucket):
    """A destination whose write stores the wrong bytes, to prove the read-back check."""

    def write(self, key: str, obj: cmb.StoredObject) -> None:
        self.calls.append("write")
        self.objects[key] = obj.data + b"!"
        self.content_types[key] = obj.content_type


class UntypedDestination(MemoryBucket):
    """A destination that stores every object as application/octet-stream, as the bug did."""

    def write(self, key: str, obj: cmb.StoredObject) -> None:
        self.calls.append("write")
        self.objects[key] = obj.data
        self.content_types[key] = DEFAULT_TYPE


def fake_clock() -> mock.Mock:
    return mock.Mock(side_effect=[10.0, 12.5])


class CopyBucketTests(unittest.TestCase):
    def test_copies_every_object_and_reports_count_and_bytes(self) -> None:
        source = RecordingSource({"media/a.png": b"aaa", "media/b.jpg": b"bbbb"})
        destination = MemoryBucket()
        report = cmb.copy_bucket(source, destination, prefix=None, clock=fake_clock())
        self.assertEqual(
            destination.objects, {"media/a.png": b"aaa", "media/b.jpg": b"bbbb"}
        )
        self.assertEqual(report.listed, 2)
        self.assertEqual(report.copied, 2)
        self.assertEqual(report.skipped_identical, 0)
        self.assertEqual(report.total_bytes, 7)
        self.assertEqual(report.duration_seconds, 2.5)

    def test_copied_object_keeps_its_content_type(self) -> None:
        source = RecordingSource(
            {"media/a.png": b"png-bytes", "media/b.mp4": b"video"},
            {"media/a.png": "image/png", "media/b.mp4": "video/mp4"},
        )
        destination = MemoryBucket()
        cmb.copy_bucket(source, destination, prefix=None, clock=fake_clock())
        self.assertEqual(destination.content_types["media/a.png"], "image/png")
        self.assertEqual(destination.content_types["media/b.mp4"], "video/mp4")

    def test_destination_object_with_same_bytes_but_other_type_is_refused(self) -> None:
        source = RecordingSource({"k": b"same"}, {"k": "image/png"})
        destination = MemoryBucket({"k": b"same"}, {"k": "text/plain"})
        with self.assertRaises(cmb.CopyError):
            cmb.copy_bucket(source, destination, prefix=None, clock=fake_clock())
        self.assertEqual(destination.content_types["k"], "text/plain")
        self.assertNotIn("write", destination.calls)

    def test_read_back_with_wrong_content_type_fails_the_copy(self) -> None:
        source = RecordingSource({"k": b"payload"}, {"k": "image/png"})
        with self.assertRaises(cmb.CopyError):
            cmb.copy_bucket(
                source, UntypedDestination(), prefix=None, clock=fake_clock()
            )

    def test_source_is_only_ever_listed_and_read(self) -> None:
        source = RecordingSource({"k1": b"x", "k2": b"y"})
        cmb.copy_bucket(source, MemoryBucket(), prefix=None, clock=fake_clock())
        self.assertEqual(set(source.calls), {"list_keys", "read"})

    def test_source_has_no_write_or_delete_method(self) -> None:
        source = RecordingSource({"k": b"x"})
        for name in (
            "write",
            "put",
            "delete",
            "write_object",
            "delete_object",
            "put_object",
        ):
            self.assertFalse(hasattr(source, name), name)

    def test_read_only_bucket_class_has_no_write_or_delete(self) -> None:
        for name in ("write", "put_object", "delete", "delete_object"):
            self.assertFalse(hasattr(cmb.ReadOnlyBucket, name), name)

    def test_identical_object_already_at_destination_is_skipped(self) -> None:
        source = RecordingSource(
            {"k": b"same", "new": b"fresh"}, {"k": "image/png", "new": "image/jpeg"}
        )
        destination = MemoryBucket({"k": b"same"}, {"k": "image/png"})
        report = cmb.copy_bucket(source, destination, prefix=None, clock=fake_clock())
        self.assertEqual(report.copied, 1)
        self.assertEqual(report.skipped_identical, 1)
        self.assertEqual(destination.objects["new"], b"fresh")
        self.assertEqual(destination.content_types["new"], "image/jpeg")
        self.assertEqual(destination.calls.count("write"), 1)

    def test_different_object_at_destination_is_refused_not_overwritten(self) -> None:
        source = RecordingSource({"k": b"source bytes"})
        destination = MemoryBucket({"k": b"other bytes"})
        with self.assertRaises(cmb.CopyError):
            cmb.copy_bucket(source, destination, prefix=None, clock=fake_clock())
        self.assertEqual(destination.objects["k"], b"other bytes")
        self.assertNotIn("write", destination.calls)

    def test_read_back_mismatch_fails_the_copy(self) -> None:
        source = RecordingSource({"k": b"payload"})
        with self.assertRaises(cmb.CopyError):
            cmb.copy_bucket(
                source, CorruptingDestination(), prefix=None, clock=fake_clock()
            )

    def test_prefix_limits_what_is_listed_and_copied(self) -> None:
        source = RecordingSource({"tenant/a": b"1", "other/b": b"2"})
        destination = MemoryBucket()
        report = cmb.copy_bucket(
            source, destination, prefix="tenant/", clock=fake_clock()
        )
        self.assertEqual(list(destination.objects), ["tenant/a"])
        self.assertEqual(report.listed, 1)

    def test_empty_source_is_refused_unless_allowed(self) -> None:
        with self.assertRaises(cmb.CopyConfigError):
            cmb.copy_bucket(
                RecordingSource({}), MemoryBucket(), prefix=None, clock=fake_clock()
            )

    def test_empty_source_copies_nothing_and_reports_zero_when_allowed(self) -> None:
        report = cmb.copy_bucket(
            RecordingSource({}),
            MemoryBucket(),
            prefix=None,
            allow_empty=True,
            clock=fake_clock(),
        )
        self.assertEqual((report.listed, report.copied, report.total_bytes), (0, 0, 0))


class DryRunTests(unittest.TestCase):
    def test_dry_run_lists_what_would_be_copied_and_writes_nothing(self) -> None:
        source = RecordingSource({"new": b"a", "k": b"b"})
        destination = MemoryBucket({"k": b"b"})
        plan = cmb.plan_copy(source, destination, prefix=None)
        self.assertEqual(plan.to_copy, ["new"])
        self.assertEqual(plan.already_present, ["k"])
        self.assertEqual(plan.listed, 2)
        self.assertEqual(set(source.calls), {"list_keys"})
        self.assertEqual(destination.calls, ["list_keys"])
        self.assertEqual(destination.objects, {"k": b"b"})

    def test_dry_run_report_names_the_count_and_says_nothing_was_written(self) -> None:
        plan = cmb.DryRunPlan(listed=2, to_copy=["a"], already_present=["b"])
        text = cmb.format_dry_run(plan)
        self.assertIn("would copy a", text)
        self.assertIn("already at destination b", text)
        self.assertIn("nothing written", text)

    def test_dry_run_refuses_an_empty_source_unless_allowed(self) -> None:
        with self.assertRaises(cmb.CopyConfigError):
            cmb.plan_copy(RecordingSource({}), MemoryBucket(), prefix=None)
        plan = cmb.plan_copy(
            RecordingSource({}), MemoryBucket(), prefix=None, allow_empty=True
        )
        self.assertEqual(plan.listed, 0)


class ConfigTests(unittest.TestCase):
    def test_same_bucket_is_refused(self) -> None:
        a = cmb.BucketAddress("b", "hel1.your-objectstorage.com", "hel1", "k", "s")
        b = cmb.BucketAddress("b", "hel1.your-objectstorage.com", "hel1", "k2", "s2")
        with self.assertRaises(cmb.CopyConfigError):
            cmb.refuse_same_bucket(a, b)

    def test_different_endpoint_same_name_is_allowed(self) -> None:
        a = cmb.BucketAddress("b", "hel1.your-objectstorage.com", "hel1", "k", "s")
        b = cmb.BucketAddress("b", "fsn1.your-objectstorage.com", "fsn1", "k", "s")
        cmb.refuse_same_bucket(a, b)

    def test_missing_credential_is_refused_before_any_read(self) -> None:
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            self.assertRaises(cmb.CopyConfigError),
        ):
            cmb._env(cmb.SOURCE_KEY_ENV)

    def test_secret_is_not_in_the_address_repr(self) -> None:
        address = cmb.BucketAddress("b", "h", "r", "AKIDVISIBLE", "SECRETVALUE")
        self.assertNotIn("SECRETVALUE", repr(address))
        self.assertNotIn("AKIDVISIBLE", repr(address))


class AdapterTests(unittest.TestCase):
    """The real adapters pass their address through to the shared SigV4 functions."""

    def test_source_adapter_lists_and_gets_through_shared_functions(self) -> None:
        address = cmb.BucketAddress(
            "src", "hel1.your-objectstorage.com", "hel1", "ak", "sk"
        )
        with (
            mock.patch.object(
                cmb, "list_objects", return_value=[{"key": "a", "last_modified": ""}]
            ) as lister,
            mock.patch.object(
                cmb,
                "get_object_with_content_type",
                return_value=(b"bytes", "image/png"),
            ) as getter,
            mock.patch.object(cmb, "put_object") as putter,
        ):
            bucket = cmb.ReadOnlyBucket(address)
            self.assertEqual(bucket.list_keys(None), ["a"])
            self.assertEqual(bucket.read("a"), cmb.StoredObject(b"bytes", "image/png"))
        lister.assert_called_once()
        getter.assert_called_once()
        putter.assert_not_called()

    def test_destination_adapter_puts_only_to_its_own_bucket(self) -> None:
        address = cmb.BucketAddress(
            "dst", "fsn1.your-objectstorage.com", "fsn1", "ak", "sk"
        )
        with mock.patch.object(cmb, "put_object") as putter:
            cmb.WritableBucket(address).write(
                "a", cmb.StoredObject(b"bytes", "image/png")
            )
        self.assertEqual(putter.call_args.kwargs["bucket"], "dst")
        self.assertEqual(
            putter.call_args.kwargs["endpoint"], "fsn1.your-objectstorage.com"
        )

    def test_destination_adapter_passes_the_content_type_to_put(self) -> None:
        address = cmb.BucketAddress(
            "dst", "fsn1.your-objectstorage.com", "fsn1", "ak", "sk"
        )
        with mock.patch.object(cmb, "put_object") as putter:
            cmb.WritableBucket(address).write(
                "a", cmb.StoredObject(b"bytes", "image/png")
            )
        self.assertEqual(putter.call_args.kwargs["content_type"], "image/png")


class MainTests(unittest.TestCase):
    """main() through the adapters, with the shared SigV4 calls replaced."""

    ENV: ClassVar[dict[str, str]] = {
        cmb.SOURCE_KEY_ENV: "ak1",
        cmb.SOURCE_SECRET_ENV: "sk1",
        cmb.DEST_KEY_ENV: "ak2",
        cmb.DEST_SECRET_ENV: "sk2",
    }
    ARGV: ClassVar[list[str]] = [
        "--source-bucket",
        "src",
        "--source-endpoint",
        "hel1.your-objectstorage.com",
        "--source-region",
        "hel1",
        "--dest-bucket",
        "dst",
        "--dest-endpoint",
        "fsn1.your-objectstorage.com",
        "--dest-region",
        "fsn1",
    ]

    def _listing(self, source_keys: list[str]):
        def fake_list(*, bucket: str, **_: object) -> list[dict[str, str]]:
            if bucket == "src":
                return [{"key": key, "last_modified": ""} for key in source_keys]
            return []

        return fake_list

    def test_empty_source_exits_nonzero_by_default(self) -> None:
        with (
            mock.patch.dict(os.environ, self.ENV, clear=True),
            mock.patch.object(cmb, "list_objects", side_effect=self._listing([])),
            mock.patch.object(cmb, "put_object") as putter,
        ):
            self.assertEqual(cmb.main(self.ARGV), 1)
        putter.assert_not_called()

    def test_empty_source_exits_zero_with_allow_empty(self) -> None:
        with (
            mock.patch.dict(os.environ, self.ENV, clear=True),
            mock.patch.object(cmb, "list_objects", side_effect=self._listing([])),
            mock.patch.object(cmb, "put_object") as putter,
        ):
            self.assertEqual(cmb.main([*self.ARGV, "--allow-empty"]), 0)
        putter.assert_not_called()

    def test_dry_run_exits_zero_and_writes_nothing(self) -> None:
        with (
            mock.patch.dict(os.environ, self.ENV, clear=True),
            mock.patch.object(
                cmb, "list_objects", side_effect=self._listing(["a/one.png"])
            ),
            mock.patch.object(cmb, "get_object_with_content_type") as getter,
            mock.patch.object(cmb, "put_object") as putter,
        ):
            self.assertEqual(cmb.main([*self.ARGV, "--dry-run"]), 0)
        putter.assert_not_called()
        getter.assert_not_called()


class ReportTests(unittest.TestCase):
    def test_report_line_names_count_bytes_and_duration(self) -> None:
        line = cmb.format_report(cmb.CopyReport(3, 2, 1, 1234, 7.5))
        self.assertIn("listed 3", line)
        self.assertIn("copied 2", line)
        self.assertIn("total 1234 bytes", line)
        self.assertIn("7.5 s", line)


if __name__ == "__main__":
    unittest.main()

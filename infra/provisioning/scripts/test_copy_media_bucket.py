#!/usr/bin/env python3
"""Unit tests for copy_media_bucket.py, against in-memory fake buckets. No network.

The source fake records every method called on it and declares no write or
delete method, so a copy that writes or deletes at the source fails here.
See copy_media_bucket.md.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

import copy_media_bucket as cmb


class MemoryBucket:
    """An in-memory bucket with list, read and write."""

    def __init__(self, objects: dict[str, bytes] | None = None) -> None:
        self.objects: dict[str, bytes] = dict(objects or {})
        self.calls: list[str] = []

    def list_keys(self, prefix: str | None) -> list[str]:
        self.calls.append("list_keys")
        return [key for key in self.objects if prefix is None or key.startswith(prefix)]

    def read(self, key: str) -> bytes:
        self.calls.append("read")
        return self.objects[key]

    def write(self, key: str, data: bytes) -> None:
        self.calls.append("write")
        self.objects[key] = data


class RecordingSource:
    """The source the copy is given. It declares list and read only, and records its calls."""

    def __init__(self, objects: dict[str, bytes]) -> None:
        self._bucket = MemoryBucket(objects)

    @property
    def calls(self) -> list[str]:
        return self._bucket.calls

    def list_keys(self, prefix: str | None) -> list[str]:
        return self._bucket.list_keys(prefix)

    def read(self, key: str) -> bytes:
        return self._bucket.read(key)


class CorruptingDestination(MemoryBucket):
    """A destination whose write stores the wrong bytes, to prove the read-back check."""

    def write(self, key: str, data: bytes) -> None:
        self.calls.append("write")
        self.objects[key] = data + b"!"


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
        source = RecordingSource({"k": b"same", "new": b"fresh"})
        destination = MemoryBucket({"k": b"same"})
        report = cmb.copy_bucket(source, destination, prefix=None, clock=fake_clock())
        self.assertEqual(report.copied, 1)
        self.assertEqual(report.skipped_identical, 1)
        self.assertEqual(destination.objects["new"], b"fresh")
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

    def test_empty_source_copies_nothing_and_reports_zero(self) -> None:
        report = cmb.copy_bucket(
            RecordingSource({}), MemoryBucket(), prefix=None, clock=fake_clock()
        )
        self.assertEqual((report.listed, report.copied, report.total_bytes), (0, 0, 0))


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
            mock.patch.object(cmb, "get_object", return_value=b"bytes") as getter,
            mock.patch.object(cmb, "put_object") as putter,
        ):
            bucket = cmb.ReadOnlyBucket(address)
            self.assertEqual(bucket.list_keys(None), ["a"])
            self.assertEqual(bucket.read("a"), b"bytes")
        lister.assert_called_once()
        getter.assert_called_once()
        putter.assert_not_called()

    def test_destination_adapter_puts_only_to_its_own_bucket(self) -> None:
        address = cmb.BucketAddress(
            "dst", "fsn1.your-objectstorage.com", "fsn1", "ak", "sk"
        )
        with mock.patch.object(cmb, "put_object") as putter:
            cmb.WritableBucket(address).write("a", b"bytes")
        self.assertEqual(putter.call_args.kwargs["bucket"], "dst")
        self.assertEqual(
            putter.call_args.kwargs["endpoint"], "fsn1.your-objectstorage.com"
        )


class ReportTests(unittest.TestCase):
    def test_report_line_names_count_bytes_and_duration(self) -> None:
        line = cmb.format_report(cmb.CopyReport(3, 2, 1, 1234, 7.5))
        self.assertIn("listed 3", line)
        self.assertIn("copied 2", line)
        self.assertIn("total 1234 bytes", line)
        self.assertIn("7.5 s", line)


if __name__ == "__main__":
    unittest.main()

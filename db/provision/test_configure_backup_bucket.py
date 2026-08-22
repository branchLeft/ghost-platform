#!/usr/bin/env python3
"""Unit tests for configure_backup_bucket.py.

No real network call: `put` is always a fake. What matters here is the
sequencing (versioning before lifecycle costs nothing and reads more
naturally in the bucket's history) and that a failed first call never
reaches the second.
"""

import base64
import hashlib
import unittest

import configure_backup_bucket as cbb


class DocumentTests(unittest.TestCase):
    def test_versioning_document_enables_versioning(self):
        self.assertIn(b"<Status>Enabled</Status>", cbb.versioning_document())

    def test_lifecycle_document_uses_the_given_noncurrent_days(self):
        doc = cbb.lifecycle_document(35)
        self.assertIn(b"<NoncurrentDays>35</NoncurrentDays>", doc)

    def test_lifecycle_document_is_deterministic_for_the_same_input(self):
        self.assertEqual(cbb.lifecycle_document(35), cbb.lifecycle_document(35))


class ConfigureBackupBucketTests(unittest.TestCase):
    def test_enables_versioning_then_sets_the_lifecycle(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            put=fake_put,
        )

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["subresource"], "versioning")
        self.assertNotIn("content_md5", calls[0])
        self.assertEqual(calls[1]["subresource"], "lifecycle")

    def test_lifecycle_call_carries_a_correct_content_md5(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            put=fake_put,
        )
        lifecycle_call = calls[1]
        expected = base64.b64encode(
            hashlib.md5(lifecycle_call["body"], usedforsecurity=False).digest()
        ).decode()
        self.assertEqual(lifecycle_call["content_md5"], expected)

    def test_a_failed_versioning_call_never_reaches_lifecycle(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)
            if kwargs["subresource"] == "versioning":
                raise cbb.ObjectStorageError("boom")

        with self.assertRaises(cbb.ObjectStorageError):
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                put=fake_put,
            )
        self.assertEqual(len(calls), 1)

    def test_custom_noncurrent_days_is_threaded_through(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            noncurrent_days=10,
            put=fake_put,
        )
        self.assertIn(b"<NoncurrentDays>10</NoncurrentDays>", calls[1]["body"])


class MainTests(unittest.TestCase):
    def test_refuses_without_credentials(self):
        import contextlib
        import io
        import os
        from unittest import mock

        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AWS_ACCESS_KEY_ID", None)
            os.environ.pop("AWS_SECRET_ACCESS_KEY", None)
            with contextlib.redirect_stderr(stderr):
                code = cbb.main(["--bucket", "b", "--endpoint", "hel1.your-objectstorage.com", "--region", "hel1"])
        self.assertEqual(code, 2)
        self.assertIn("AWS_ACCESS_KEY_ID", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

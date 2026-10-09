#!/usr/bin/env python3
"""Tests for configure_state_bucket.py against a fake provider."""

from __future__ import annotations

import unittest
import urllib.parse

import configure_state_bucket as csb


class FakeProvider:
    def __init__(self, *, honour_versioning=True, honour_lifecycle=True):
        self.versioning = None
        self.lifecycle = None
        self.created = False
        self.honour_versioning, self.honour_lifecycle = honour_versioning, honour_lifecycle

    def __call__(self, url, headers, payload, method):
        query = urllib.parse.urlparse(url).query
        if method == "PUT" and not query:
            if self.created:
                return 409, b"<Code>BucketAlreadyOwnedByYou</Code>"
            self.created = True
            return 200, b""
        if method == "PUT" and query.startswith("versioning"):
            self.versioning = payload if self.honour_versioning else None
            return 200, b""
        if method == "PUT" and query.startswith("lifecycle"):
            assert "content-md5" in {k.lower() for k in headers}
            self.lifecycle = payload if self.honour_lifecycle else None
            return 200, b""
        if method == "GET" and query.startswith("versioning"):
            return 200, self.versioning or b'<VersioningConfiguration xmlns="x"/>'
        if method == "GET" and query.startswith("lifecycle"):
            return (200, self.lifecycle) if self.lifecycle else (404, b"")
        return 500, b""


def run(provider, **kw):
    return csb.configure(bucket="b-state", endpoint="e.test", region="r", access_key="A" * 20,
                         secret_key="S", transport=provider, **kw)


class ConfigureStateBucketTest(unittest.TestCase):
    def test_creates_and_reads_back_both_settings(self):
        got = run(FakeProvider())
        self.assertEqual(got["versioning"], "Enabled")
        self.assertEqual(got["noncurrent_days"], 90)

    def test_rerun_on_an_existing_bucket_is_idempotent(self):
        provider = FakeProvider()
        run(provider)
        self.assertEqual(run(provider)["noncurrent_days"], 90)

    def test_accepted_but_ignored_versioning_is_caught_by_the_read_back(self):
        with self.assertRaises(csb.StateBucketError):
            run(FakeProvider(honour_versioning=False))

    def test_accepted_but_ignored_lifecycle_is_caught_by_the_read_back(self):
        with self.assertRaises(csb.StateBucketError):
            run(FakeProvider(honour_lifecycle=False))

    def test_expiry_is_configurable_and_must_be_positive(self):
        self.assertEqual(run(FakeProvider(), noncurrent_days=30)["noncurrent_days"], 30)
        with self.assertRaises(csb.StateBucketError):
            csb.lifecycle_document(0)

    def test_main_needs_the_admin_key(self):
        self.assertEqual(csb.main(["--bucket", "b-state", "--endpoint", "e", "--region", "r"]), 2)


if __name__ == "__main__":
    unittest.main()

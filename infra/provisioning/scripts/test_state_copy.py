#!/usr/bin/env python3
"""Tests for state_copy.py against an in-memory store and real `age`."""

from __future__ import annotations

import io
import json
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

import state_copy as sc
from media_backup_restore import MediaRestoreVerificationError
from shared_objectstorage import ObjectStorageError


class Store:
    def __init__(self):
        self.b: dict[str, dict[str, bytes]] = {}
        self.puts: list[str] = []

    def lister(self, *, bucket, prefix=None, **_):
        return [{"key": k} for k in sorted(self.b.get(bucket, {})) if k.startswith(prefix or "")]

    def getter(self, *, bucket, key, **_):
        return self.b[bucket][key]

    def putter(self, *, bucket, key, data, **_):
        self.puts.append(key)
        self.b.setdefault(bucket, {})[key] = data


def keypair(directory: pathlib.Path):
    path = directory / "id.txt"
    out = subprocess.run(["age-keygen", "-o", str(path)], capture_output=True, text=True, check=True)
    return str(path), out.stderr.split("Public key:")[1].strip()


class StateCopyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.identity, recipient = keypair(self.dir)
        env = {"STATE_COPY_RECIPIENT": recipient}
        for prefix, bucket in (("DEST", "copy1"), ("ESTATE", "estate-b"), ("TENANT", "tenant-b")):
            env.update({f"STATE_COPY_{prefix}_{n}": v for n, v in (
                ("BUCKET", bucket), ("ENDPOINT", "e.test"), ("REGION", "r"),
                ("ACCESS_KEY_ID", "AKID"), ("SECRET_ACCESS_KEY", "SECRET"))})
        self.env = env
        self.cfg = sc.load_config(env)
        self.store = Store()
        self.store.b["estate-b"] = {".pulumi/stacks/mail/production.json": b'{"a":1}', ".pulumi/meta.yaml": b"v: 1"}
        self.store.b["tenant-b"] = {".pulumi/stacks/t1/t1.json": b"{}"}
        self.hooks = dict(lister=self.store.lister, getter=self.store.getter, putter=self.store.putter)

    def tearDown(self):
        self.tmp.cleanup()

    def test_config_refuses_partial_or_bad_recipient(self):
        env = dict(self.env)
        del env["STATE_COPY_TENANT_SECRET_ACCESS_KEY"]
        with self.assertRaises(sc.ConfigError):
            sc.load_config(env)
        with self.assertRaises(sc.ConfigError):
            sc.load_config({**self.env, "STATE_COPY_RECIPIENT": "age1x,age1y"})

    def test_copy_then_restore_round_trips_and_manifest_is_last(self):
        result = sc.copy_bucket("estate", self.cfg, **self.hooks)
        self.assertEqual(result["objects"], 2)
        self.assertTrue(self.store.puts[-1].endswith(sc.MANIFEST_NAME))
        self.assertTrue(all(k.startswith("state/estate/generations/") for k in self.store.puts))
        out = self.dir / "restored"
        got = sc.restore("estate", self.cfg, identity_path=self.identity, into=out,
                         lister=self.store.lister, getter=self.store.getter)
        self.assertEqual(got["objects"], 2)
        self.assertEqual((out / ".pulumi/stacks/mail/production.json").read_bytes(), b'{"a":1}')

    def test_object_names_are_not_visible_in_copy_1(self):
        sc.copy_bucket("tenant", self.cfg, **self.hooks)
        blob = b"".join(self.store.b["copy1"].values()) + "".join(self.store.puts).encode()
        self.assertNotIn(b".pulumi", blob)
        self.assertNotIn(b"t1.json", blob)

    def test_empty_or_stackless_listing_is_refused_and_writes_nothing(self):
        self.store.b["estate-b"] = {}
        with self.assertRaises(sc.StateCopyError):
            sc.copy_bucket("estate", self.cfg, **self.hooks)
        self.store.b["estate-b"] = {"other.txt": b"x"}
        with self.assertRaises(sc.StateCopyError):
            sc.copy_bucket("estate", self.cfg, **self.hooks)
        self.assertEqual(self.store.puts, [])

    def test_source_read_failure_is_a_copy_error(self):
        def boom(**_):
            raise ObjectStorageError("403")
        with self.assertRaises(sc.StateCopyError):
            sc.copy_bucket("estate", self.cfg, lister=boom, getter=boom, putter=boom)

    def test_restore_refuses_tampered_ciphertext_and_incomplete_generation(self):
        sc.copy_bucket("estate", self.cfg, **self.hooks)
        tar_key = next(k for k in self.store.puts if k.endswith(sc.TAR_NAME))
        manifest_key = next(k for k in self.store.puts if k.endswith(sc.MANIFEST_NAME))
        recipient = self.env["STATE_COPY_RECIPIENT"]
        from media_backup_restore import encrypt_with_age
        forged = sc.pack({".pulumi/stacks/x.json": b"forged"})
        self.store.b["copy1"][tar_key] = encrypt_with_age(data=forged, recipient=recipient)
        with self.assertRaises(MediaRestoreVerificationError):
            sc.restore("estate", self.cfg, identity_path=self.identity, into=self.dir / "o1",
                       lister=self.store.lister, getter=self.store.getter)
        padded = sc.pack({k: v for k, v in self.store.b["estate-b"].items()}) + b"\0" * 1024
        self.store.b["copy1"][tar_key] = encrypt_with_age(data=padded, recipient=recipient)
        with self.assertRaises(MediaRestoreVerificationError):
            sc.restore("estate", self.cfg, identity_path=self.identity, into=self.dir / "o3",
                       lister=self.store.lister, getter=self.store.getter)
        del self.store.b["copy1"][manifest_key]
        with self.assertRaises(MediaRestoreVerificationError):
            sc.restore("estate", self.cfg, identity_path=self.identity, into=self.dir / "o2",
                       lister=self.store.lister, getter=self.store.getter)

    def test_a_two_recipient_ciphertext_is_refused_before_anything_is_written(self):
        (self.dir / "two").mkdir()
        _, second = keypair(self.dir / "two")
        both = ["age", "-r", self.env["STATE_COPY_RECIPIENT"], "-r", second]

        def two(*, data, recipient):
            return subprocess.run(both, input=data, capture_output=True, check=True).stdout

        orig = sc.encrypt_with_age
        sc.encrypt_with_age = two
        try:
            with self.assertRaises(sc.StateCopyError):
                sc.copy_bucket("estate", self.cfg, **self.hooks)
        finally:
            sc.encrypt_with_age = orig
        self.assertEqual(self.store.puts, [])

    def test_restore_refuses_path_traversal(self):
        with self.assertRaises(MediaRestoreVerificationError):
            sc._safe_target(self.dir, "../escape")

    def test_failed_bucket_keeps_old_success_and_run_exits_1(self):
        metrics = str(self.dir / "m")
        clock = iter([1000.0, 2000.0, 3000.0])
        self.assertEqual(sc.run_copy(self.cfg, metrics, now=lambda: next(clock), **self.hooks), 0)
        self.store.b["tenant-b"] = {}
        self.assertEqual(sc.run_copy(self.cfg, metrics, now=lambda: next(clock), **self.hooks), 1)
        text = (pathlib.Path(metrics) / sc.METRICS_FILENAME).read_text()
        self.assertIn(f'{sc.M_SUCCESS}{{bucket="tenant"}} 2000.0', text)
        self.assertIn(f'{sc.M_SUCCESS}{{bucket="estate"}} 3000.0', text)
        self.assertIn(f'{sc.M_CONFIGURED}{{bucket="tenant"}} 1.0', text)

    def test_configured_gauge_exists_before_any_success(self):
        metrics = str(self.dir / "m")
        self.store.b["estate-b"] = {}
        self.store.b["tenant-b"] = {}
        self.assertEqual(sc.run_copy(self.cfg, metrics, **self.hooks), 1)
        text = (pathlib.Path(metrics) / sc.METRICS_FILENAME).read_text()
        self.assertIn(f'{sc.M_CONFIGURED}{{bucket="estate"}}', text)
        self.assertNotIn(f'{sc.M_SUCCESS}{{', text)

    def test_main_refuses_without_credentials(self):
        self.assertEqual(sc.main(["--env-file", str(self.dir / "missing")]), 2)


if __name__ == "__main__":
    unittest.main()

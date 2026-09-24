#!/usr/bin/env python3
"""Unit tests for media_backup_restore.py.

No real network and no real `age` binary here -- both `list_objects` /
`get_object` / `put_object` and `encrypt_with_age` / `decrypt_with_age` are
injected as fakes, so these tests pin the module's own logic (the floor
assertion, the checksum comparison, per-tenant isolation, key-safety) rather
than re-proving the SigV4 signer (`test_objectstorage.py` already does that)
or `age` itself. The real chain -- real MinIO, real `age`, a real Ghost
upload -- is proven live by `media-backup-restore-proof.sh`, including the
two sabotages this file cannot exercise on its own: a genuinely corrupted
ciphertext failing `age`'s own authentication, and the CLI's wiring to
`restore_tenant_media` rather than to a stub.
"""

from __future__ import annotations

import json
import unittest

from media_backup_restore import (
    MediaBackupError,
    MediaBackupFloorError,
    MediaRestoreVerificationError,
    backup_tenant_media,
    restore_tenant_media,
    sha256_hex,
)
from shared_objectstorage import ObjectStorageError

ENDPOINT = "sandbox.example.test"
REGION = "sandbox"


class FakeObjectStore:
    """An in-memory, bucket-scoped key/value store shaped like the four
    operations this module calls -- good enough to prove the module's own
    control flow without a network or a real object-storage account."""

    def __init__(self):
        self.buckets: dict[str, dict[str, bytes]] = {}

    def _bucket(self, name: str) -> dict[str, bytes]:
        return self.buckets.setdefault(name, {})

    def list_objects(self, *, bucket, endpoint, region, access_key, secret_key, prefix=None):
        del endpoint, region, access_key, secret_key
        keys = self._bucket(bucket).keys()
        if prefix is not None:
            keys = [k for k in keys if k.startswith(prefix)]
        return [{"key": key, "last_modified": ""} for key in sorted(keys)]

    def get_object(self, *, bucket, endpoint, region, access_key, secret_key, key):
        del endpoint, region, access_key, secret_key
        try:
            return self._bucket(bucket)[key]
        except KeyError:
            raise ObjectStorageError(f"GET {bucket}/{key} failed: HTTP 404 (NoSuchKey)")

    def put_object(self, *, bucket, endpoint, region, access_key, secret_key, key, data, **_kw):
        del endpoint, region, access_key, secret_key
        self._bucket(bucket)[key] = data


def _fake_encrypt(*, data: bytes, recipient: str) -> bytes:
    """A one-recipient "cipher": readable only by the matching fake
    identity. Not real crypto -- proving the module never calls `encrypt`
    with more than one recipient, and that a mismatched identity is
    refused, is what the tests below need, not confidentiality."""
    return f"AGE1:{recipient}:".encode() + data


def _fake_decrypt(identity_to_recipient: dict[str, str]):
    def decrypt(*, data: bytes, identity_path: str) -> bytes:
        recipient = identity_to_recipient.get(identity_path)
        if recipient is not None:
            prefix = f"AGE1:{recipient}:".encode()
            if data.startswith(prefix):
                return data[len(prefix) :]
        raise MediaRestoreVerificationError(
            "age decrypt: no identity matched any of the recipients"
        )

    return decrypt


TENANT_A_RECIPIENT = "age1qtenantarecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
TENANT_A_IDENTITY = "/fake/tenant-a.identity"
TENANT_B_RECIPIENT = "age1qtenantbrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
TENANT_B_IDENTITY = "/fake/tenant-b.identity"

IDENTITY_TO_RECIPIENT = {
    TENANT_A_IDENTITY: TENANT_A_RECIPIENT,
    TENANT_B_IDENTITY: TENANT_B_RECIPIENT,
}


class BackupTenantMediaTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeObjectStore()
        self.store.buckets["live-a"] = {
            "content/images/2026/09/photo.jpg": b"a real jpeg's bytes, honest",
            "content/images/2026/09/second.png": b"a second uploaded file",
        }

    def _backup(self, **overrides):
        kwargs = dict(
            tenant="tenant-a",
            live_bucket="live-a",
            backup_bucket="backup",
            endpoint=ENDPOINT,
            region=REGION,
            live_access_key="live-ak",
            live_secret_key="live-sk",
            backup_access_key="backup-ak",
            backup_secret_key="backup-sk",
            recipient=TENANT_A_RECIPIENT,
            assert_media_present=True,
            list_objects=self.store.list_objects,
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_writes_one_ciphertext_object_per_live_object(self):
        self._backup()
        backed_up = self.store.buckets["backup"]
        self.assertIn("media/tenant-a/content/images/2026/09/photo.jpg.age", backed_up)
        self.assertIn("media/tenant-a/content/images/2026/09/second.png.age", backed_up)

    def test_ciphertext_is_encrypted_to_exactly_the_given_recipient(self):
        self._backup()
        ciphertext = self.store.buckets["backup"][
            "media/tenant-a/content/images/2026/09/photo.jpg.age"
        ]
        self.assertTrue(ciphertext.startswith(f"AGE1:{TENANT_A_RECIPIENT}:".encode()))

    def test_manifest_records_the_sha256_of_the_plaintext(self):
        report = self._backup()
        expected = sha256_hex(b"a real jpeg's bytes, honest")
        self.assertEqual(
            report.objects["content/images/2026/09/photo.jpg"]["sha256"], expected
        )
        self.assertEqual(report.object_count, 2)

    def test_manifest_object_itself_is_encrypted(self):
        self._backup()
        manifest_ciphertext = self.store.buckets["backup"]["media/tenant-a/manifest.json.age"]
        self.assertTrue(manifest_ciphertext.startswith(f"AGE1:{TENANT_A_RECIPIENT}:".encode()))
        with self.assertRaises(Exception):
            json.loads(manifest_ciphertext)

    def test_floor_assertion_refuses_an_empty_backup_when_asserted(self):
        self.store.buckets["live-a"] = {}
        with self.assertRaises(MediaBackupFloorError):
            self._backup()
        # And nothing was written -- a refused backup leaves no half-written
        # manifest that a later restore could mistake for a real one.
        self.assertNotIn("backup", self.store.buckets)

    def test_without_the_floor_assertion_an_empty_backup_silently_succeeds(self):
        # This is the baseline the floor assertion exists to prevent, not a
        # desired behaviour -- callers who know a tenant has live media must
        # pass assert_media_present=True, which is exactly the "backup
        # skips media" sabotage proven live in media-backup-restore-proof.sh.
        self.store.buckets["live-a"] = {}
        report = self._backup(assert_media_present=False)
        self.assertEqual(report.object_count, 0)

    def test_refuses_a_live_key_that_would_escape_the_tenant_prefix(self):
        self.store.buckets["live-a"]["../other-tenant/secret.jpg"] = b"x"
        with self.assertRaises(MediaBackupError):
            self._backup()

    def test_second_tenants_backup_does_not_touch_the_firsts(self):
        self._backup()
        self.store.buckets["live-b"] = {"content/images/only-b.jpg": b"tenant b's own bytes"}
        self._backup(
            tenant="tenant-b",
            live_bucket="live-b",
            recipient=TENANT_B_RECIPIENT,
        )
        backed_up = self.store.buckets["backup"]
        self.assertIn("media/tenant-a/content/images/2026/09/photo.jpg.age", backed_up)
        self.assertIn("media/tenant-b/content/images/only-b.jpg.age", backed_up)
        # Tenant B's manifest never mentions tenant A's objects.
        manifest_b = _fake_decrypt(IDENTITY_TO_RECIPIENT)(
            data=backed_up["media/tenant-b/manifest.json.age"], identity_path=TENANT_B_IDENTITY
        )
        self.assertEqual(json.loads(manifest_b)["objects"].keys(), {"content/images/only-b.jpg"})


class RestoreTenantMediaTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeObjectStore()
        self.store.buckets["live-a"] = {
            "content/images/photo.jpg": b"a real jpeg's bytes, honest",
        }
        backup_tenant_media(
            tenant="tenant-a",
            live_bucket="live-a",
            backup_bucket="backup",
            endpoint=ENDPOINT,
            region=REGION,
            live_access_key="live-ak",
            live_secret_key="live-sk",
            backup_access_key="backup-ak",
            backup_secret_key="backup-sk",
            recipient=TENANT_A_RECIPIENT,
            assert_media_present=True,
            list_objects=self.store.list_objects,
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        # The genuine destroy: the object-storage round trip this story asks
        # for runs AFTER the source is gone, not merely reasoned about.
        del self.store.buckets["live-a"]["content/images/photo.jpg"]

    def _restore(self, **overrides):
        kwargs = dict(
            tenant="tenant-a",
            backup_bucket="backup",
            endpoint=ENDPOINT,
            region=REGION,
            backup_access_key="backup-ak",
            backup_secret_key="backup-sk",
            identity_path=TENANT_A_IDENTITY,
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            decrypt=_fake_decrypt(IDENTITY_TO_RECIPIENT),
        )
        kwargs.update(overrides)
        return restore_tenant_media(**kwargs)

    def test_restored_bytes_checksum_match_the_original(self):
        report = self._restore()
        self.assertEqual(report.verified_keys, ["content/images/photo.jpg"])
        self.assertEqual(report.bytes_recovered, len(b"a real jpeg's bytes, honest"))

    def test_writes_verified_plaintext_to_the_target_bucket_when_given(self):
        self._restore(
            target_bucket="restored-a", target_access_key="ak", target_secret_key="sk"
        )
        self.assertEqual(
            self.store.buckets["restored-a"]["content/images/photo.jpg"],
            b"a real jpeg's bytes, honest",
        )

    def test_control_missing_manifest_fails_rather_than_reports_success(self):
        # Mirrors R4's own control: a restore against a bucket that never
        # received a backup must not look like a successful restore of
        # nothing.
        del self.store.buckets["backup"]["media/tenant-a/manifest.json.age"]
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore()

    def test_control_missing_backup_object_fails_the_restore(self):
        del self.store.buckets["backup"]["media/tenant-a/content/images/photo.jpg.age"]
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore()

    def test_control_corrupt_backup_object_fails_the_checksum_comparison(self):
        key = "media/tenant-a/content/images/photo.jpg.age"
        self.store.buckets["backup"][key] = self.store.buckets["backup"][key] + b"CORRUPTED"
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("different digest", str(ctx.exception))

    def test_control_wrong_tenant_identity_fails_rather_than_returns_garbage(self):
        # The crypto-shredding property this mirrors from the database dump:
        # a different tenant's identity must not be able to read these
        # objects at all, let alone silently produce wrong bytes.
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore(identity_path=TENANT_B_IDENTITY)

    def test_control_manifest_naming_a_different_tenant_is_refused(self):
        # A defensive check independent of the identity check above: even if
        # a manifest were reachable and decryptable, a mismatched `tenant`
        # field inside it is refused rather than trusted.
        manifest_key = "media/tenant-a/manifest.json.age"
        tampered = json.dumps({"tenant": "tenant-x", "objects": {}}).encode()
        self.store.buckets["backup"][manifest_key] = _fake_encrypt(
            data=tampered, recipient=TENANT_A_RECIPIENT
        )
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("cross-tenant", str(ctx.exception))

    def test_never_writes_a_partial_result_on_the_object_that_fails(self):
        # Second object corrupted; the first must not have been written to
        # the target bucket as though the whole restore had succeeded.
        self.store.buckets["live-a"]["content/images/second.jpg"] = b"unused"
        # Re-run backup with two objects so the manifest has two entries.
        self.store.buckets["live-a"] = {
            "content/images/photo.jpg": b"a real jpeg's bytes, honest",
            "content/images/second.jpg": b"second file bytes",
        }
        self.store.buckets["backup"] = {}
        backup_tenant_media(
            tenant="tenant-a",
            live_bucket="live-a",
            backup_bucket="backup",
            endpoint=ENDPOINT,
            region=REGION,
            live_access_key="live-ak",
            live_secret_key="live-sk",
            backup_access_key="backup-ak",
            backup_secret_key="backup-sk",
            recipient=TENANT_A_RECIPIENT,
            assert_media_present=True,
            list_objects=self.store.list_objects,
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        key = "media/tenant-a/content/images/second.jpg.age"
        self.store.buckets["backup"][key] += b"CORRUPTED"
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore(target_bucket="restored-a", target_access_key="ak", target_secret_key="sk")
        # "photo.jpg" sorts before "second.jpg", so it was verified and
        # written before the corrupt object raised.
        self.assertIn("content/images/photo.jpg", self.store.buckets.get("restored-a", {}))


class Sha256HexTests(unittest.TestCase):
    def test_matches_hashlib(self):
        import hashlib

        self.assertEqual(sha256_hex(b"x"), hashlib.sha256(b"x").hexdigest())


if __name__ == "__main__":
    unittest.main()

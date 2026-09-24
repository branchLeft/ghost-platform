#!/usr/bin/env python3
"""Unit tests for media_backup_restore.py.

No real network here -- `list_objects` / `get_object_with_content_type` /
`get_object` / `put_object` are injected as fakes, so these tests pin the
module's own logic (the floor, the checksum comparison, per-tenant
isolation, key-opacity, the recipient-count guard) rather than re-proving the
SigV4 signer (`test_objectstorage.py` already does that). `age` itself IS
real in `RecipientStanzaCountTests` -- the count this module trusts is
checked against real `age` output, not only against a value this file
invents -- and in `EncryptWithAgeArgvTests`, which captures the real argv a
fake `run` receives. The full chain -- real MinIO, real Ghost, the CLI's own
exit code, and a live reproduction of a second-recipient ciphertext -- is
proven by `media-backup-restore-proof.sh`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from unittest import mock

from media_backup_restore import (
    MediaBackupError,
    MediaBackupFloorError,
    MediaBackupRecipientError,
    MediaRestoreVerificationError,
    _manifest_key,
    _object_key_for_backup,
    backup_tenant_media,
    count_age_recipient_stanzas,
    encrypt_with_age,
    generate_backup_object_id,
    main,
    restore_tenant_media,
    sha256_hex,
)
from shared_objectstorage import ObjectStorageError

ENDPOINT = "sandbox.example.test"
REGION = "sandbox"

AGE_AVAILABLE = shutil.which("age") is not None
AGE_KEYGEN_AVAILABLE = shutil.which("age-keygen") is not None


class FakeObjectStore:
    """An in-memory, bucket-scoped key/value store shaped like the four
    operations this module calls -- good enough to prove the module's own
    control flow without a network or a real object-storage account."""

    def __init__(self):
        self.buckets: dict[str, dict[str, bytes]] = {}
        self.content_types: dict[str, dict[str, str]] = {}

    def _bucket(self, name: str) -> dict[str, bytes]:
        return self.buckets.setdefault(name, {})

    def put(self, bucket: str, key: str, data: bytes, content_type: str = "application/octet-stream"):
        self._bucket(bucket)[key] = data
        self.content_types.setdefault(bucket, {})[key] = content_type

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

    def get_object_with_content_type(self, *, bucket, endpoint, region, access_key, secret_key, key):
        data = self.get_object(
            bucket=bucket, endpoint=endpoint, region=region, access_key=access_key,
            secret_key=secret_key, key=key,
        )
        content_type = self.content_types.get(bucket, {}).get(key, "application/octet-stream")
        return data, content_type

    def put_object(self, *, bucket, endpoint, region, access_key, secret_key, key, data, content_type="application/octet-stream", **_kw):
        del endpoint, region, access_key, secret_key
        self.put(bucket, key, data, content_type)


def _fake_encrypt(*, data: bytes, recipient: str) -> bytes:
    """A one-recipient "cipher", shaped like real `age`'s header just enough
    for `count_age_recipient_stanzas` to read it correctly: one `-> `
    stanza line per recipient, a `---` line, then the "ciphertext". Not real
    crypto -- `RecipientStanzaCountTests` below is what proves the counter
    against genuine `age` output."""
    return f"-> X25519 {recipient}\nstanza-body\n---\n".encode() + data


def _fake_encrypt_two_recipients(*, data: bytes, recipient: str) -> bytes:
    """Simulates the exact defect this module's runtime guard exists to
    catch: an `encrypt` call that (however it happened) produced a
    ciphertext carrying two recipient stanzas."""
    return (
        f"-> X25519 {recipient}\nstanza-body\n"
        f"-> X25519 age1anotherrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nstanza-body\n"
        f"---\n"
    ).encode() + data


def _fake_decrypt(identity_to_recipient: dict[str, str]):
    def decrypt(*, data: bytes, identity_path: str) -> bytes:
        recipient = identity_to_recipient.get(identity_path)
        if recipient is not None:
            prefix = f"-> X25519 {recipient}\nstanza-body\n---\n".encode()
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


def _decrypt_manifest(store: FakeObjectStore, *, bucket: str, tenant: str, identity_path: str) -> dict:
    ciphertext = store.get_object(
        bucket=bucket, endpoint=ENDPOINT, region=REGION, access_key="x", secret_key="x",
        key=_manifest_key(tenant),
    )
    plaintext = _fake_decrypt(IDENTITY_TO_RECIPIENT)(data=ciphertext, identity_path=identity_path)
    return json.loads(plaintext)


class GenerateBackupObjectIdTests(unittest.TestCase):
    def test_is_64_lowercase_hex_characters(self):
        object_id = generate_backup_object_id(digest="irrelevant")
        self.assertRegex(object_id, r"\A[0-9a-f]{64}\Z")

    def test_two_calls_never_collide_in_a_reasonable_sample(self):
        ids = {generate_backup_object_id(digest="d") for _ in range(1000)}
        self.assertEqual(len(ids), 1000)

    def test_ignores_the_digest_it_is_given(self):
        # The parameter exists so a test (or, hypothetically, a caller) can
        # inject a content-derived replacement and show what this function
        # itself refuses to do -- it must not do that by default.
        same_digest = "a" * 64
        first = generate_backup_object_id(digest=same_digest)
        second = generate_backup_object_id(digest=same_digest)
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, same_digest)


class RecipientStanzaCountTests(unittest.TestCase):
    """The counter this module's runtime guard trusts, checked against real
    `age` output -- a passing table only evidences the counter's MODEL of
    the format once it is shown to agree with the real binary, not before."""

    @unittest.skipUnless(AGE_AVAILABLE and AGE_KEYGEN_AVAILABLE, "age/age-keygen not installed")
    def test_a_real_one_recipient_ciphertext_counts_one(self):
        keygen = subprocess.run(["age-keygen"], capture_output=True, check=True)
        recipient = next(
            line.split(b": ", 1)[1].decode()
            for line in keygen.stderr.splitlines()
            if line.startswith(b"Public key: ")
        )
        ciphertext = subprocess.run(
            ["age", "-r", recipient], input=b"hello", capture_output=True, check=True
        ).stdout
        self.assertEqual(count_age_recipient_stanzas(ciphertext), 1)

    @unittest.skipUnless(AGE_AVAILABLE and AGE_KEYGEN_AVAILABLE, "age/age-keygen not installed")
    def test_a_real_two_recipient_ciphertext_counts_two(self):
        recipients = []
        for _ in range(2):
            keygen = subprocess.run(["age-keygen"], capture_output=True, check=True)
            recipients.append(
                next(
                    line.split(b": ", 1)[1].decode()
                    for line in keygen.stderr.splitlines()
                    if line.startswith(b"Public key: ")
                )
            )
        ciphertext = subprocess.run(
            ["age", "-r", recipients[0], "-r", recipients[1]],
            input=b"hello",
            capture_output=True,
            check=True,
        ).stdout
        self.assertEqual(count_age_recipient_stanzas(ciphertext), 2)

    def test_fake_encrypt_helper_agrees_with_the_real_shape(self):
        # The fakes above are trusted as stand-ins for real `age` output
        # only because their header shape matches what the two tests above
        # confirm about the real thing: one `-> ` line per recipient, then
        # `---`.
        self.assertEqual(count_age_recipient_stanzas(_fake_encrypt(data=b"x", recipient="r")), 1)
        self.assertEqual(
            count_age_recipient_stanzas(_fake_encrypt_two_recipients(data=b"x", recipient="r")), 2
        )


class EncryptWithAgeArgvTests(unittest.TestCase):
    def test_the_argv_carries_exactly_one_dash_r_flag(self):
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            return subprocess.CompletedProcess(argv, 0, stdout=b"ciphertext", stderr=b"")

        encrypt_with_age(data=b"x", recipient=TENANT_A_RECIPIENT, run=fake_run)
        self.assertEqual(captured["argv"].count("-r"), 1)
        self.assertEqual(captured["argv"], ["age", "-r", TENANT_A_RECIPIENT])


class BackupTenantMediaTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put(
            "live-a", "content/images/2026/09/photo.jpg",
            b"a real jpeg's bytes, honest", content_type="image/jpeg",
        )
        self.store.put(
            "live-a", "content/images/2026/09/second.png",
            b"a second uploaded file", content_type="image/png",
        )

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
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def _manifest(self, tenant="tenant-a", identity_path=TENANT_A_IDENTITY):
        return _decrypt_manifest(self.store, bucket="backup", tenant=tenant, identity_path=identity_path)

    def test_writes_one_ciphertext_object_per_live_object_addressed_by_backup_id(self):
        report = self._backup()
        manifest = self._manifest()
        backed_up = self.store.buckets["backup"]
        for live_key in ("content/images/2026/09/photo.jpg", "content/images/2026/09/second.png"):
            backup_id = manifest["objects"][live_key]["backup_id"]
            self.assertIn(_object_key_for_backup("tenant-a", backup_id), backed_up)
        self.assertEqual(report.object_count, 2)
        self.assertFalse(report.deliberately_empty)

    def test_ciphertext_is_encrypted_to_exactly_the_given_recipient(self):
        self._backup()
        manifest = self._manifest()
        backup_id = manifest["objects"]["content/images/2026/09/photo.jpg"]["backup_id"]
        ciphertext = self.store.buckets["backup"][_object_key_for_backup("tenant-a", backup_id)]
        self.assertEqual(count_age_recipient_stanzas(ciphertext), 1)
        self.assertIn(TENANT_A_RECIPIENT.encode(), ciphertext)

    def test_manifest_records_sha256_size_content_type_and_a_backup_id(self):
        report = self._backup()
        expected_digest = sha256_hex(b"a real jpeg's bytes, honest")
        entry = report.objects["content/images/2026/09/photo.jpg"]
        self.assertEqual(entry["sha256"], expected_digest)
        self.assertEqual(entry["size"], len(b"a real jpeg's bytes, honest"))
        self.assertEqual(entry["content_type"], "image/jpeg")
        self.assertRegex(entry["backup_id"], r"\A[0-9a-f]{64}\Z")

    def test_manifest_object_itself_is_encrypted(self):
        self._backup()
        manifest_ciphertext = self.store.buckets["backup"]["media/tenant-a/manifest.json.age"]
        self.assertEqual(count_age_recipient_stanzas(manifest_ciphertext), 1)
        with self.assertRaises(Exception):
            json.loads(manifest_ciphertext)

    def test_backup_object_keys_never_contain_the_live_key(self):
        self._backup()
        for key in self.store.buckets["backup"]:
            self.assertNotIn("photo.jpg", key)
            self.assertNotIn("second.png", key)
            self.assertNotIn("2026/09", key)

    def test_backup_object_keys_are_not_derived_from_the_plaintext_digest(self):
        # Review cycle 2's finding: a content-addressed key is a
        # fingerprint that survives crypto-shredding, because it needs no
        # key at all to recompute from a known or guessed plaintext.
        self._backup()
        photo_digest = sha256_hex(b"a real jpeg's bytes, honest")
        second_digest = sha256_hex(b"a second uploaded file")
        backup_keys = list(self.store.buckets["backup"])
        self.assertFalse(any(photo_digest in key for key in backup_keys))
        self.assertFalse(any(second_digest in key for key in backup_keys))

    def test_sabotage_a_digest_derived_backup_id_is_caught_by_that_assertion(self):
        # Reproduces the exact regression review cycle 2 found -- an id
        # generator that returns the plaintext digest instead of a random
        # id -- and shows the assertion above would have caught it.
        self._backup(generate_backup_id=lambda *, digest: digest)
        photo_digest = sha256_hex(b"a real jpeg's bytes, honest")
        backup_keys = list(self.store.buckets["backup"])
        with self.assertRaises(AssertionError):
            self.assertFalse(any(photo_digest in key for key in backup_keys))
        # And, directly: the sabotaged run's key IS the digest.
        self.assertIn(_object_key_for_backup("tenant-a", photo_digest), backup_keys)

    def test_a_live_object_literally_named_manifest_json_does_not_collide(self):
        self.store.put("live-a", "manifest.json", b"not actually a manifest")
        report = self._backup()
        manifest = self._manifest()
        self.assertEqual(manifest["tenant"], "tenant-a")
        self.assertEqual(manifest["object_count"], 3)
        self.assertIn("manifest.json", report.objects)
        backup_id = manifest["objects"]["manifest.json"]["backup_id"]
        self.assertIn(_object_key_for_backup("tenant-a", backup_id), self.store.buckets["backup"])

    def test_floor_refuses_an_empty_live_bucket_by_default(self):
        self.store.buckets["live-a"] = {}
        self.store.content_types["live-a"] = {}
        with self.assertRaises(MediaBackupFloorError):
            self._backup()
        self.assertNotIn("backup", self.store.buckets)

    def test_confirm_tenant_has_no_media_allows_a_genuinely_empty_backup(self):
        self.store.buckets["live-a"] = {}
        self.store.content_types["live-a"] = {}
        report = self._backup(confirm_tenant_has_no_media=True)
        self.assertEqual(report.object_count, 0)
        self.assertTrue(report.deliberately_empty)
        manifest = self._manifest()
        self.assertTrue(manifest["deliberately_empty"])

    def test_confirm_flag_is_ignored_when_media_actually_exists(self):
        report = self._backup(confirm_tenant_has_no_media=True)
        self.assertFalse(report.deliberately_empty)
        self.assertEqual(report.object_count, 2)

    def test_a_second_recipient_in_the_ciphertext_is_refused(self):
        with self.assertRaises(MediaBackupRecipientError):
            self._backup(encrypt=_fake_encrypt_two_recipients)

    def test_a_second_recipient_in_the_manifest_ciphertext_is_also_refused(self):
        calls = []

        def encrypt_manifest_with_two_recipients(*, data, recipient):
            calls.append(data)
            if len(calls) <= 2:  # the two objects: fine
                return _fake_encrypt(data=data, recipient=recipient)
            return _fake_encrypt_two_recipients(data=data, recipient=recipient)  # the manifest

        with self.assertRaises(MediaBackupRecipientError) as ctx:
            self._backup(encrypt=encrypt_manifest_with_two_recipients)
        self.assertIn("manifest", str(ctx.exception))

    def test_second_tenants_backup_does_not_touch_the_firsts(self):
        self._backup()
        manifest_a = self._manifest()
        self.store.put("live-b", "content/images/only-b.jpg", b"tenant b's own bytes")
        self._backup(
            tenant="tenant-b",
            live_bucket="live-b",
            recipient=TENANT_B_RECIPIENT,
        )
        manifest_b = self._manifest(tenant="tenant-b", identity_path=TENANT_B_IDENTITY)
        backed_up = self.store.buckets["backup"]
        a_backup_id = manifest_a["objects"]["content/images/2026/09/photo.jpg"]["backup_id"]
        b_backup_id = manifest_b["objects"]["content/images/only-b.jpg"]["backup_id"]
        self.assertIn(_object_key_for_backup("tenant-a", a_backup_id), backed_up)
        self.assertIn(_object_key_for_backup("tenant-b", b_backup_id), backed_up)
        self.assertNotEqual(a_backup_id, b_backup_id)


class RestoreTenantMediaTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put(
            "live-a", "content/images/photo.jpg",
            b"a real jpeg's bytes, honest", content_type="image/jpeg",
        )
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
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        # The genuine destroy: the object-storage round trip this story asks
        # for runs AFTER the source is gone, not merely reasoned about.
        del self.store.buckets["live-a"]["content/images/photo.jpg"]

    def _manifest(self):
        return _decrypt_manifest(self.store, bucket="backup", tenant="tenant-a", identity_path=TENANT_A_IDENTITY)

    def _backup_key_for(self, live_key: str) -> str:
        manifest = self._manifest()
        return _object_key_for_backup("tenant-a", manifest["objects"][live_key]["backup_id"])

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

    def test_writes_verified_plaintext_to_the_target_bucket_with_the_original_content_type(self):
        self._restore(target_bucket="restored-a", target_access_key="ak", target_secret_key="sk")
        self.assertEqual(
            self.store.buckets["restored-a"]["content/images/photo.jpg"],
            b"a real jpeg's bytes, honest",
        )
        self.assertEqual(
            self.store.content_types["restored-a"]["content/images/photo.jpg"], "image/jpeg"
        )

    def test_control_missing_manifest_fails_rather_than_reports_success(self):
        del self.store.buckets["backup"]["media/tenant-a/manifest.json.age"]
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore()

    def test_control_missing_backup_object_fails_the_restore(self):
        backup_key = self._backup_key_for("content/images/photo.jpg")
        del self.store.buckets["backup"][backup_key]
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore()

    def test_control_corrupt_backup_object_fails_the_checksum_comparison(self):
        backup_key = self._backup_key_for("content/images/photo.jpg")
        self.store.buckets["backup"][backup_key] += b"CORRUPTED"
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("different digest", str(ctx.exception))

    def test_control_wrong_tenant_identity_fails_rather_than_returns_garbage(self):
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore(identity_path=TENANT_B_IDENTITY)

    def test_control_manifest_naming_a_different_tenant_is_refused(self):
        manifest_key = "media/tenant-a/manifest.json.age"
        tampered = json.dumps({"tenant": "tenant-x", "objects": {}, "deliberately_empty": True}).encode()
        self.store.buckets["backup"][manifest_key] = _fake_encrypt(
            data=tampered, recipient=TENANT_A_RECIPIENT
        )
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("cross-tenant", str(ctx.exception))

    def test_control_zero_objects_without_the_deliberate_mark_is_refused(self):
        manifest_key = "media/tenant-a/manifest.json.age"
        tampered = json.dumps({"tenant": "tenant-a", "objects": {}}).encode()  # no deliberately_empty at all
        self.store.buckets["backup"][manifest_key] = _fake_encrypt(
            data=tampered, recipient=TENANT_A_RECIPIENT
        )
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("deliberately_empty", str(ctx.exception))

    def test_control_an_unsafe_live_key_from_a_forged_manifest_is_refused_before_writing_to_target(self):
        # A manifest is decrypted, not thereby trusted (branchLeft/workspace#1346).
        # This constructs one naming a path-escaping live key and confirms
        # restore refuses it before any write to the target bucket, rather
        # than trusting whatever the manifest says to write.
        real_manifest = self._manifest()
        real_entry = real_manifest["objects"]["content/images/photo.jpg"]
        forged = {
            "tenant": "tenant-a",
            "objects": {"../../escape.jpg": real_entry},
            "deliberately_empty": False,
        }
        self.store.buckets["backup"]["media/tenant-a/manifest.json.age"] = _fake_encrypt(
            data=json.dumps(forged).encode(), recipient=TENANT_A_RECIPIENT
        )
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore(target_bucket="restored-a", target_access_key="ak", target_secret_key="sk")
        self.assertIn("unsafe live key", str(ctx.exception))
        self.assertNotIn("restored-a", self.store.buckets)

    def test_a_genuinely_deliberately_empty_manifest_restores_as_success(self):
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
            confirm_tenant_has_no_media=True,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        report = self._restore()
        self.assertEqual(report.verified_keys, [])
        self.assertEqual(report.bytes_recovered, 0)

    def test_a_partial_restore_writes_already_verified_objects_before_the_failure(self):
        # Not "never partial" -- the return value never is, but a target
        # write for an object that already verified is real and stays real
        # even when a LATER object in the same manifest fails. This test
        # asserts exactly that, matching the module docstring rather than
        # overstating it.
        self.store.buckets["live-a"] = {
            "content/images/photo.jpg": b"a real jpeg's bytes, honest",
            "content/images/second.jpg": b"second file bytes",
        }
        self.store.content_types["live-a"] = {
            "content/images/photo.jpg": "image/jpeg",
            "content/images/second.jpg": "image/jpeg",
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
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object,
            encrypt=_fake_encrypt,
        )
        backup_key = self._backup_key_for("content/images/second.jpg")
        self.store.buckets["backup"][backup_key] += b"CORRUPTED"
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore(target_bucket="restored-a", target_access_key="ak", target_secret_key="sk")
        # "photo.jpg" sorts before "second.jpg", so it was verified and
        # written before the corrupt object raised -- a real, intended
        # partial write, not a bug.
        self.assertIn("content/images/photo.jpg", self.store.buckets.get("restored-a", {}))
        self.assertNotIn("content/images/second.jpg", self.store.buckets.get("restored-a", {}))


class MainWiringTests(unittest.TestCase):
    """Proves the CLI's argument parsing actually reaches the function calls
    it claims to, not only that the process exits the right code -- the
    exact class of defect the reviewer demonstrated by breaking
    `assert_media_present=False` inside `main()` while every other test
    stayed green: mock the two entry points and assert on the KWARGS `main`
    passed them, not merely on the return code."""

    def setUp(self):
        self.env = {
            "MEDIA_LIVE_ACCESS_KEY_ID": "lak",
            "MEDIA_LIVE_SECRET_ACCESS_KEY": "lsk",
            "MEDIA_BACKUP_ACCESS_KEY_ID": "bak",
            "MEDIA_BACKUP_SECRET_ACCESS_KEY": "bsk",
            "AGE_RECIPIENT_PUBLIC_KEY": TENANT_A_RECIPIENT,
        }
        self.env_patch = mock.patch.dict("os.environ", self.env, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    @mock.patch("media_backup_restore.backup_tenant_media")
    def test_backup_without_the_flag_passes_confirm_false(self, mock_backup):
        mock_backup.return_value = mock.Mock(tenant="t", object_count=1, deliberately_empty=False)
        rc = main(
            [
                "backup", "--tenant", "t", "--live-bucket", "lb", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION,
            ]
        )
        self.assertEqual(rc, 0)
        self.assertEqual(mock_backup.call_args.kwargs["confirm_tenant_has_no_media"], False)
        self.assertEqual(mock_backup.call_args.kwargs["tenant"], "t")
        self.assertEqual(mock_backup.call_args.kwargs["recipient"], TENANT_A_RECIPIENT)

    @mock.patch("media_backup_restore.backup_tenant_media")
    def test_backup_with_the_flag_passes_confirm_true(self, mock_backup):
        mock_backup.return_value = mock.Mock(tenant="t", object_count=0, deliberately_empty=True)
        rc = main(
            [
                "backup", "--tenant", "t", "--live-bucket", "lb", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION, "--confirm-tenant-has-no-media",
            ]
        )
        self.assertEqual(rc, 0)
        self.assertEqual(mock_backup.call_args.kwargs["confirm_tenant_has_no_media"], True)

    @mock.patch("media_backup_restore.backup_tenant_media")
    def test_backup_exits_1_when_the_floor_raises(self, mock_backup):
        mock_backup.side_effect = MediaBackupFloorError("no media")
        rc = main(
            [
                "backup", "--tenant", "t", "--live-bucket", "lb", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION,
            ]
        )
        self.assertEqual(rc, 1)

    @mock.patch("media_backup_restore.restore_tenant_media")
    def test_restore_passes_the_identity_file_and_target_bucket_through(self, mock_restore):
        mock_restore.return_value = mock.Mock(tenant="t", verified_keys=["k"], bytes_recovered=5)
        rc = main(
            [
                "restore", "--tenant", "t", "--backup-bucket", "bb", "--target-bucket", "tb",
                "--endpoint", ENDPOINT, "--region", REGION, "--identity-file", "/tmp/id",
            ]
        )
        self.assertEqual(rc, 0)
        self.assertEqual(mock_restore.call_args.kwargs["identity_path"], "/tmp/id")
        self.assertEqual(mock_restore.call_args.kwargs["target_bucket"], "tb")

    @mock.patch("media_backup_restore.restore_tenant_media")
    def test_restore_exits_1_when_verification_raises(self, mock_restore):
        mock_restore.side_effect = MediaRestoreVerificationError("digest mismatch")
        rc = main(
            [
                "restore", "--tenant", "t", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION, "--identity-file", "/tmp/id",
            ]
        )
        self.assertEqual(rc, 1)

    def test_missing_env_var_exits_1_before_any_network_call(self):
        del os.environ["AGE_RECIPIENT_PUBLIC_KEY"]
        rc = main(
            [
                "backup", "--tenant", "t", "--live-bucket", "lb", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION,
            ]
        )
        self.assertEqual(rc, 1)


class Sha256HexTests(unittest.TestCase):
    def test_matches_hashlib(self):
        import hashlib

        self.assertEqual(sha256_hex(b"x"), hashlib.sha256(b"x").hexdigest())


if __name__ == "__main__":
    unittest.main()

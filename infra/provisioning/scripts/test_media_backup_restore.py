#!/usr/bin/env python3
"""Unit tests for media_backup_restore.py, with fakes for every storage call
except `age` itself in the stanza-count and argv tests.
See test_media_backup_restore.md#module-overview.
"""

from __future__ import annotations

import inspect
import io
import json
import os
import shutil
import subprocess
import unittest
import urllib.error
import urllib.parse
from unittest import mock

from media_backup_restore import (
    MediaBackupError,
    MediaBackupFloorError,
    MediaBackupRecipientError,
    MediaRestoreVerificationError,
    _generation_key_pattern,
    _manifest_key,
    _object_key_for_backup,
    _tenant_generations_prefix,
    backup_tenant_media,
    count_age_recipient_stanzas,
    encrypt_with_age,
    find_newest_generation,
    generate_backup_object_id,
    generate_run_id,
    main,
    restore_tenant_media,
    sha256_hex,
)
import media_backup_restore
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

    def delete_object(self, *, bucket, endpoint, region, access_key, secret_key, key):
        del endpoint, region, access_key, secret_key
        # Idempotent, like the real DELETE (db/provision/objectstorage.py
        # tolerates a 404) -- a re-run deleting a key it already removed
        # must not be treated as a bug.
        self._bucket(bucket).pop(key, None)
        self.content_types.get(bucket, {}).pop(key, None)


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


def _newest_manifest_key(store: FakeObjectStore, *, bucket: str, tenant: str) -> str:
    found = find_newest_generation(
        tenant=tenant, backup_bucket=bucket, endpoint=ENDPOINT, region=REGION,
        access_key="x", secret_key="x", list_objects=store.list_objects,
    )
    assert found is not None, f"no generation with a manifest for tenant {tenant!r}"
    return found[1]


def _decrypt_manifest(store: FakeObjectStore, *, bucket: str, tenant: str, identity_path: str) -> dict:
    ciphertext = store.get_object(
        bucket=bucket, endpoint=ENDPOINT, region=REGION, access_key="x", secret_key="x",
        key=_newest_manifest_key(store, bucket=bucket, tenant=tenant),
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


class GenerateRunIdTests(unittest.TestCase):
    def test_shape_is_timestamp_then_random_suffix(self):
        run_id = generate_run_id()
        self.assertRegex(run_id, r"\A[0-9]{8}T[0-9]{12}Z-[0-9a-f]{16}\Z")

    def test_two_calls_never_collide_in_a_reasonable_sample(self):
        ids = {generate_run_id() for _ in range(200)}
        self.assertEqual(len(ids), 200)

    def test_successive_calls_sort_chronologically(self):
        # Not a hard real-time guarantee -- see the module docstring's own
        # comment on the random suffix -- but under ordinary, non-adversarial
        # timing, generating ids in sequence should sort in the same order.
        ids = [generate_run_id() for _ in range(20)]
        self.assertEqual(ids, sorted(ids))


class TenantSlugValidationTests(unittest.TestCase):
    """`tenant` is validated as a strict slug at the boundary of both
    public functions, before it is used to build a single key -- a `/` or a
    `..` can never reach a key, and no tenant's name can widen another's
    prefix."""

    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put("live-a", "a.jpg", b"a bytes")

    def _backup(self, tenant, **overrides):
        kwargs = dict(
            tenant=tenant, live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_valid_slugs_are_accepted(self):
        for tenant in ("a", "tenant-a", "tenant-a-b-c", "a1", "9tenant", "a" * 63):
            with self.subTest(tenant=tenant):
                report = self._backup(tenant)
                self.assertEqual(report.tenant, tenant)

    def test_a_slash_in_the_tenant_is_refused_before_any_write(self):
        # A tenant string that looks like a nested path: "acme" vs "acme/objects/sub" could
        # only ever collide because the second string was accepted at all.
        with self.assertRaises(MediaBackupError) as ctx:
            self._backup("acme/objects/sub")
        self.assertIn("not a valid slug", str(ctx.exception))
        self.assertNotIn("backup", self.store.buckets)

    def test_dot_dot_in_the_tenant_is_refused(self):
        with self.assertRaises(MediaBackupError):
            self._backup("../escape")

    def test_uppercase_is_refused(self):
        with self.assertRaises(MediaBackupError):
            self._backup("Tenant-A")

    def test_empty_string_is_refused(self):
        with self.assertRaises(MediaBackupError):
            self._backup("")

    def test_leading_or_trailing_hyphen_is_refused(self):
        with self.assertRaises(MediaBackupError):
            self._backup("-tenant")
        with self.assertRaises(MediaBackupError):
            self._backup("tenant-")

    def test_too_long_is_refused(self):
        with self.assertRaises(MediaBackupError):
            self._backup("a" * 64)

    def test_restore_also_validates_the_tenant(self):
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            restore_tenant_media(
                tenant="acme/objects/sub", backup_bucket="backup", endpoint=ENDPOINT,
                region=REGION, backup_access_key="x", backup_secret_key="x",
                identity_path=TENANT_A_IDENTITY, list_objects=self.store.list_objects,
                get_object=self.store.get_object, put_object=self.store.put_object,
                decrypt=_fake_decrypt(IDENTITY_TO_RECIPIENT),
            )
        self.assertIn("not a valid slug", str(ctx.exception))

    def test_sabotage_a_prefix_sharing_tenant_pair_no_longer_collides(self):
        # RED (pre-validation): calling
        # backup for "acme" then reading back "acme/objects/sub"'s restore
        # used to see "acme"'s objects, because nothing stopped
        # "acme/objects/sub" from being accepted as a tenant string in the
        # first place and its flat objects/ prefix was a string-prefix of
        # "acme"'s. GREEN (this test, against the real, current function):
        # the nested-looking tenant is refused outright, so the collision
        # cannot occur any more.
        self.store.put("live-x", "x.jpg", b"x bytes")
        with self.assertRaises(MediaBackupError):
            self._backup("acme/objects/sub", live_bucket="live-x")
        # "acme" itself still works normally and is untouched by the refusal
        # above (nothing was ever written for the invalid tenant).
        report = self._backup("acme")
        self.assertEqual(report.tenant, "acme")


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
            self.assertIn(_object_key_for_backup("tenant-a", report.run_id, backup_id), backed_up)
        self.assertEqual(report.object_count, 2)
        self.assertFalse(report.deliberately_empty)

    def test_ciphertext_is_encrypted_to_exactly_the_given_recipient(self):
        report = self._backup()
        manifest = self._manifest()
        backup_id = manifest["objects"]["content/images/2026/09/photo.jpg"]["backup_id"]
        ciphertext = self.store.buckets["backup"][_object_key_for_backup("tenant-a", report.run_id, backup_id)]
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
        report = self._backup()
        manifest_ciphertext = self.store.buckets["backup"][_manifest_key("tenant-a", report.run_id)]
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
        # A content-addressed key is a fingerprint that survives
        # crypto-shredding, because it needs no key at all to recompute
        # from a known or guessed plaintext.
        self._backup()
        photo_digest = sha256_hex(b"a real jpeg's bytes, honest")
        second_digest = sha256_hex(b"a second uploaded file")
        backup_keys = list(self.store.buckets["backup"])
        self.assertFalse(any(photo_digest in key for key in backup_keys))
        self.assertFalse(any(second_digest in key for key in backup_keys))

    def test_sabotage_a_digest_derived_backup_id_is_caught_by_that_assertion(self):
        # Reproduces the exact regression this control exists to catch -- an
        # id generator that returns the plaintext digest instead of a random
        # id -- and shows the assertion above would have caught it.
        report = self._backup(generate_backup_id=lambda *, digest: digest)
        photo_digest = sha256_hex(b"a real jpeg's bytes, honest")
        backup_keys = list(self.store.buckets["backup"])
        with self.assertRaises(AssertionError):
            self.assertFalse(any(photo_digest in key for key in backup_keys))
        # And, directly: the sabotaged run's key IS the digest.
        self.assertIn(_object_key_for_backup("tenant-a", report.run_id, photo_digest), backup_keys)

    def test_a_live_object_literally_named_manifest_json_does_not_collide(self):
        self.store.put("live-a", "manifest.json", b"not actually a manifest")
        report = self._backup()
        manifest = self._manifest()
        self.assertEqual(manifest["tenant"], "tenant-a")
        self.assertEqual(manifest["object_count"], 3)
        self.assertIn("manifest.json", report.objects)
        backup_id = manifest["objects"]["manifest.json"]["backup_id"]
        self.assertIn(_object_key_for_backup("tenant-a", report.run_id, backup_id), self.store.buckets["backup"])

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
        report_a = self._backup()
        manifest_a = self._manifest()
        self.store.put("live-b", "content/images/only-b.jpg", b"tenant b's own bytes")
        report_b = self._backup(
            tenant="tenant-b",
            live_bucket="live-b",
            recipient=TENANT_B_RECIPIENT,
        )
        manifest_b = self._manifest(tenant="tenant-b", identity_path=TENANT_B_IDENTITY)
        backed_up = self.store.buckets["backup"]
        a_backup_id = manifest_a["objects"]["content/images/2026/09/photo.jpg"]["backup_id"]
        b_backup_id = manifest_b["objects"]["content/images/only-b.jpg"]["backup_id"]
        self.assertIn(_object_key_for_backup("tenant-a", report_a.run_id, a_backup_id), backed_up)
        self.assertIn(_object_key_for_backup("tenant-b", report_b.run_id, b_backup_id), backed_up)
        self.assertNotEqual(a_backup_id, b_backup_id)


class RestoreTenantMediaTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put(
            "live-a", "content/images/photo.jpg",
            b"a real jpeg's bytes, honest", content_type="image/jpeg",
        )
        self.report = backup_tenant_media(
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
        # The genuine destroy: the object-storage round trip has to run
        # AFTER the source is gone, not merely be reasoned about.
        del self.store.buckets["live-a"]["content/images/photo.jpg"]

    def _manifest(self):
        return _decrypt_manifest(self.store, bucket="backup", tenant="tenant-a", identity_path=TENANT_A_IDENTITY)

    def _manifest_key(self):
        return _manifest_key("tenant-a", self.report.run_id)

    def _backup_key_for(self, live_key: str) -> str:
        manifest = self._manifest()
        return _object_key_for_backup("tenant-a", self.report.run_id, manifest["objects"][live_key]["backup_id"])

    def _restore(self, **overrides):
        kwargs = dict(
            tenant="tenant-a",
            backup_bucket="backup",
            endpoint=ENDPOINT,
            region=REGION,
            backup_access_key="backup-ak",
            backup_secret_key="backup-sk",
            identity_path=TENANT_A_IDENTITY,
            list_objects=self.store.list_objects,
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
        del self.store.buckets["backup"][self._manifest_key()]
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
        manifest_key = self._manifest_key()
        tampered = json.dumps({"tenant": "tenant-x", "objects": {}, "deliberately_empty": True}).encode()
        self.store.buckets["backup"][manifest_key] = _fake_encrypt(
            data=tampered, recipient=TENANT_A_RECIPIENT
        )
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("cross-tenant", str(ctx.exception))

    def test_control_zero_objects_without_the_deliberate_mark_is_refused(self):
        manifest_key = self._manifest_key()
        tampered = json.dumps({"tenant": "tenant-a", "objects": {}}).encode()  # no deliberately_empty at all
        self.store.buckets["backup"][manifest_key] = _fake_encrypt(
            data=tampered, recipient=TENANT_A_RECIPIENT
        )
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("deliberately_empty", str(ctx.exception))

    def test_control_an_unsafe_live_key_from_a_forged_manifest_is_refused_before_writing_to_target(self):
        # A manifest is decrypted, not thereby trusted: age authenticates
        # only that the given identity can decrypt it, not who wrote it.
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
        self.store.buckets["backup"][self._manifest_key()] = _fake_encrypt(
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

    def test_no_generation_at_all_fails_rather_than_reports_success(self):
        self.store.buckets["backup"] = {}
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore()

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
        fresh = backup_tenant_media(
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
        self.report = fresh  # this test's own fresh run, not setUp's single-object one
        backup_key = self._backup_key_for("content/images/second.jpg")
        self.store.buckets["backup"][backup_key] += b"CORRUPTED"
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore(target_bucket="restored-a", target_access_key="ak", target_secret_key="sk")
        # "photo.jpg" sorts before "second.jpg", so it was verified and
        # written before the corrupt object raised -- a real, intended
        # partial write, not a bug.
        self.assertIn("content/images/photo.jpg", self.store.buckets.get("restored-a", {}))
        self.assertNotIn("content/images/second.jpg", self.store.buckets.get("restored-a", {}))


class RestoreFallbackTests(unittest.TestCase):
    """A caught failure must never leave the tenant unrestorable by
    default. A lossy-put run (this run's own presence check catches a
    missing object before ever writing a manifest) leaves the PREVIOUS
    generation as the newest one with a manifest, so a default restore
    succeeds without needing --run-id at all. A manifest
    READ-BACK MISMATCH is different: the manifest key DOES exist (the PUT
    itself reported success), so this run becomes the (broken) newest
    generation, and the default restore must name the newest OLDER
    generation with a manifest and the exact --run-id command to recover
    it -- never fall back on its own."""

    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put("live-a", "a.jpg", b"a bytes")

    def _backup(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def _restore(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", backup_bucket="backup", endpoint=ENDPOINT, region=REGION,
            backup_access_key="x", backup_secret_key="x", identity_path=TENANT_A_IDENTITY,
            list_objects=self.store.list_objects, get_object=self.store.get_object,
            put_object=self.store.put_object, decrypt=_fake_decrypt(IDENTITY_TO_RECIPIENT),
        )
        kwargs.update(overrides)
        return restore_tenant_media(**kwargs)

    def test_an_explicit_run_id_that_has_no_manifest_is_refused_by_name(self):
        self._backup()
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore(run_id="20260101T000000000000Z-0000000000000000")
        self.assertIn("no manifest at generation", str(ctx.exception))

    def test_a_manifest_entry_with_no_backup_id_raises_the_normal_verification_error(self):
        # A manifest a hostile or corrupt writer produced, decryptable and
        # valid JSON, but missing the one field restore needs to locate the
        # object -- must reach the same fallback path as any other
        # verification failure, never escape as a KeyError/TypeError
        # traceback.
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"
        newer_run_id = "20990101T000000000000Z-0000000000000000"
        broken_manifest = {
            "tenant": "tenant-a",
            "run_id": newer_run_id,
            "objects": {"a.jpg": {"sha256": "0" * 64, "size": 1, "content_type": "image/jpeg"}},
            "object_count": 1,
            "deliberately_empty": False,
        }
        self.store.buckets["backup"][_manifest_key("tenant-a", newer_run_id)] = _fake_encrypt(
            data=json.dumps(broken_manifest).encode(), recipient=TENANT_A_RECIPIENT
        )

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        message = str(ctx.exception)
        self.assertIn("backup_id", message)
        self.assertIn(f"--run-id {good.run_id}", message)

        # GREEN: the named fallback still recovers the tenant.
        recovered = self._restore(run_id=good.run_id)
        self.assertEqual(recovered.verified_keys, ["a.jpg"])

    def test_a_manifest_entry_with_a_malformed_backup_id_raises_the_normal_verification_error(self):
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"
        newer_run_id = "20990101T000000000000Z-0000000000000001"
        broken_manifest = {
            "tenant": "tenant-a",
            "run_id": newer_run_id,
            "objects": {
                "a.jpg": {
                    "sha256": "0" * 64, "size": 1, "content_type": "image/jpeg",
                    "backup_id": "not-64-hex-chars",
                }
            },
            "object_count": 1,
            "deliberately_empty": False,
        }
        self.store.buckets["backup"][_manifest_key("tenant-a", newer_run_id)] = _fake_encrypt(
            data=json.dumps(broken_manifest).encode(), recipient=TENANT_A_RECIPIENT
        )

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        message = str(ctx.exception)
        self.assertIn("backup_id", message)
        self.assertIn(f"--run-id {good.run_id}", message)

        recovered = self._restore(run_id=good.run_id)
        self.assertEqual(recovered.verified_keys, ["a.jpg"])

    def test_a_manifest_that_is_not_a_json_object_raises_the_normal_verification_error(self):
        # A decrypted manifest that IS valid JSON, but not an object (a
        # list, here) must not escape as an AttributeError from
        # `manifest.get` -- it has to reach the same "restore it explicitly
        # with --run-id" fallback path as any other verification failure.
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"
        newer_run_id = "20990101T000000000000Z-0000000000000002"
        self.store.buckets["backup"][_manifest_key("tenant-a", newer_run_id)] = _fake_encrypt(
            data=json.dumps(["not", "an", "object"]).encode(), recipient=TENANT_A_RECIPIENT
        )

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        message = str(ctx.exception)
        self.assertIn("not a JSON object", message)
        self.assertIn(f"--run-id {good.run_id}", message)

        recovered = self._restore(run_id=good.run_id)
        self.assertEqual(recovered.verified_keys, ["a.jpg"])

    def test_a_manifest_whose_objects_field_is_not_a_dict_raises_the_normal_verification_error(self):
        # `objects` that decrypts to a non-dict JSON value (a list,
        # here) must not escape as an AttributeError from `.items()`.
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"
        newer_run_id = "20990101T000000000000Z-0000000000000003"
        broken_manifest = {
            "tenant": "tenant-a",
            "run_id": newer_run_id,
            "objects": ["not", "a", "dict"],
            "object_count": 1,
            "deliberately_empty": False,
        }
        self.store.buckets["backup"][_manifest_key("tenant-a", newer_run_id)] = _fake_encrypt(
            data=json.dumps(broken_manifest).encode(), recipient=TENANT_A_RECIPIENT
        )

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        message = str(ctx.exception)
        self.assertIn("not a JSON object", message)
        self.assertIn(f"--run-id {good.run_id}", message)

        recovered = self._restore(run_id=good.run_id)
        self.assertEqual(recovered.verified_keys, ["a.jpg"])

    def test_a_manifest_entry_with_no_sha256_raises_the_normal_verification_error(self):
        # An entry missing 'sha256' must not escape as a KeyError from
        # the digest comparison -- the backup object itself is real and
        # decrypts fine, so this exercises the digest lookup specifically,
        # not the earlier backup_id/missing-object checks.
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"
        newer_run_id = "20990101T000000000000Z-0000000000000004"
        backup_id = "b" * 64
        backup_key = _object_key_for_backup("tenant-a", newer_run_id, backup_id)
        self.store.buckets["backup"][backup_key] = _fake_encrypt(
            data=b"some ciphertext content", recipient=TENANT_A_RECIPIENT
        )
        broken_manifest = {
            "tenant": "tenant-a",
            "run_id": newer_run_id,
            "objects": {
                "a.jpg": {"size": 1, "content_type": "image/jpeg", "backup_id": backup_id}
            },
            "object_count": 1,
            "deliberately_empty": False,
        }
        self.store.buckets["backup"][_manifest_key("tenant-a", newer_run_id)] = _fake_encrypt(
            data=json.dumps(broken_manifest).encode(), recipient=TENANT_A_RECIPIENT
        )

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        message = str(ctx.exception)
        self.assertIn("sha256", message)
        self.assertIn(f"--run-id {good.run_id}", message)

        recovered = self._restore(run_id=good.run_id)
        self.assertEqual(recovered.verified_keys, ["a.jpg"])


class _FakeResponse:
    def __init__(self, status: int, body: bytes, headers: dict[str, str]):
        self.status = status
        self._body = body
        self.headers = headers

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class PutOnlyHttp:
    """A fake S3 endpoint patched in for `urllib.request.urlopen`, so the REAL
    signing and request code in `shared_objectstorage` runs and every request
    this module could make is observed, however it is routed. A bucket in
    `put_only` answers 403 to anything but a PUT, the way the backup bucket's
    fence does for the writer key; any other bucket allows everything."""

    def __init__(self, put_only: set[str]):
        self.put_only = put_only
        self.buckets: dict[str, dict[str, bytes]] = {}
        self.requests: list[tuple[str, str, str]] = []
        self.fail_put_after: int | None = None
        self._puts = 0

    def seed(self, bucket: str, key: str, data: bytes):
        self.buckets.setdefault(bucket, {})[key] = data

    def __call__(self, request, timeout=None):
        del timeout
        parsed = urllib.parse.urlparse(request.full_url)
        bucket, _, key = urllib.parse.unquote(parsed.path.lstrip("/")).partition("/")
        method = request.get_method()
        self.requests.append((method, bucket, key))
        if bucket in self.put_only and method != "PUT":
            raise urllib.error.HTTPError(
                request.full_url, 403, "Forbidden", {},
                io.BytesIO(b"<Error><Code>AccessDenied</Code></Error>"),
            )
        store = self.buckets.setdefault(bucket, {})
        if method == "PUT":
            self._puts += 1
            if self.fail_put_after is not None and self._puts > self.fail_put_after:
                raise OSError("connection reset")
            store[key] = request.data
            return _FakeResponse(200, b"", {})
        if method == "DELETE":
            store.pop(key, None)
            return _FakeResponse(204, b"", {})
        if key:
            if key not in store:
                raise urllib.error.HTTPError(
                    request.full_url, 404, "Not Found", {},
                    io.BytesIO(b"<Error><Code>NoSuchKey</Code></Error>"),
                )
            return _FakeResponse(200, store[key], {"Content-Type": "image/jpeg"})
        prefix = urllib.parse.parse_qs(parsed.query).get("prefix", [""])[0]
        contents = "".join(
            f"<Contents><Key>{k}</Key></Contents>" for k in sorted(store) if k.startswith(prefix)
        )
        body = f"<ListBucketResult><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
        return _FakeResponse(200, body.encode(), {})


class PutOnlyBackupTests(unittest.TestCase):
    """Backup against a bucket whose key may only PUT: the job writes a new
    dated generation and issues no delete, list or read there."""

    def setUp(self):
        self.http = PutOnlyHttp(put_only={"backup"})
        self.http.seed("live-a", "content/images/a.jpg", b"a bytes")
        self.http.seed("live-a", "content/images/b.jpg", b"b bytes")
        patcher = mock.patch("urllib.request.urlopen", self.http)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _backup(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="live-ak", live_secret_key="live-sk",
            backup_access_key="backup-ak", backup_secret_key="backup-sk",
            recipient=TENANT_A_RECIPIENT, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def _backup_requests(self):
        return [(m, k) for m, b, k in self.http.requests if b == "backup"]

    def test_a_run_succeeds_with_a_key_that_can_only_put(self):
        report = self._backup()
        self.assertEqual(report.object_count, 2)
        self.assertTrue(self._backup_requests())

    def test_no_delete_is_issued_to_any_bucket(self):
        self._backup()
        self.assertEqual([r for r in self.http.requests if r[0] == "DELETE"], [])

    def test_the_backup_bucket_only_ever_sees_puts(self):
        self._backup()
        self.assertEqual({m for m, _ in self._backup_requests()}, {"PUT"})

    def test_the_manifest_is_the_last_write_of_the_run(self):
        report = self._backup()
        keys = [k for m, k in self._backup_requests() if m == "PUT"]
        self.assertEqual(keys[-1], _manifest_key("tenant-a", report.run_id))
        self.assertEqual(len([k for k in keys if k.endswith("manifest.json.age")]), 1)
        self.assertEqual(len(keys), 3)

    def test_a_second_run_adds_a_dated_generation_and_removes_nothing(self):
        first = self._backup()
        before = set(self.http.buckets["backup"])
        second = self._backup()
        after = set(self.http.buckets["backup"])
        self.assertNotEqual(first.run_id, second.run_id)
        self.assertTrue(before < after)
        self.assertEqual(len(after), 6)
        self.assertTrue(all(k.startswith("media/tenant-a/generations/") for k in after))

    def test_every_object_lives_under_its_runs_dated_generation_prefix(self):
        report = self._backup()
        expected = f"media/tenant-a/generations/{report.run_id}/"
        self.assertTrue(all(k.startswith(expected) for k in self.http.buckets["backup"]))

    def test_a_confirmed_empty_tenant_needs_no_read_of_the_backup_bucket(self):
        self.http.buckets["live-a"] = {}
        report = self._backup(confirm_tenant_has_no_media=True)
        self.assertTrue(report.deliberately_empty)
        self.assertEqual({m for m, _ in self._backup_requests()}, {"PUT"})

    def test_a_failed_upload_writes_no_manifest_and_deletes_nothing(self):
        self.http.fail_put_after = 1
        with self.assertRaises(ObjectStorageError):
            self._backup()
        self.assertEqual(
            [k for k in self.http.buckets["backup"] if k.endswith("manifest.json.age")], []
        )
        self.assertEqual([r for r in self.http.requests if r[0] == "DELETE"], [])

    def test_the_module_has_no_delete_path(self):
        source = inspect.getsource(media_backup_restore)
        self.assertNotIn("delete_object", source)
        self.assertNotIn("DELETE", source)

    def test_the_put_only_simulation_would_refuse_a_delete(self):
        # Control for the tests above: the fake really does answer 403 to a
        # delete on the backup bucket, so a delete reintroduced into the job
        # would fail here rather than pass unnoticed.
        from shared_objectstorage import delete_object

        with self.assertRaises(ObjectStorageError):
            delete_object(
                bucket="backup", endpoint=ENDPOINT, region=REGION, access_key="x",
                secret_key="x", key="media/tenant-a/generations/x",
            )


class NewestCompleteCopyRestoreTests(unittest.TestCase):
    """Restore reads the newest dated copy that has its completion marker
    (the manifest) and ignores any copy without one."""

    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put("live-a", "a.jpg", b"a v1")

    def _backup(self, run_id: str, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            put_object=self.store.put_object, encrypt=_fake_encrypt,
            make_run_id=lambda: run_id,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def _restore(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", backup_bucket="backup", endpoint=ENDPOINT, region=REGION,
            backup_access_key="x", backup_secret_key="x", identity_path=TENANT_A_IDENTITY,
            list_objects=self.store.list_objects, get_object=self.store.get_object,
            put_object=self.store.put_object, decrypt=_fake_decrypt(IDENTITY_TO_RECIPIENT),
        )
        kwargs.update(overrides)
        return restore_tenant_media(**kwargs)

    RUN_1 = "20261001T000000000000Z-aaaaaaaaaaaaaaaa"
    RUN_2 = "20261002T000000000000Z-bbbbbbbbbbbbbbbb"
    RUN_3 = "20261003T000000000000Z-cccccccccccccccc"

    def _drop_manifest(self, run_id: str):
        del self.store.buckets["backup"][_manifest_key("tenant-a", run_id)]

    def test_picks_the_newest_of_several_complete_copies(self):
        self._backup(self.RUN_1)
        self._backup(self.RUN_3)
        self._backup(self.RUN_2)
        self.assertEqual(self._restore().run_id, self.RUN_3)

    def test_a_newer_copy_without_its_marker_is_ignored(self):
        self._backup(self.RUN_1)
        self._backup(self.RUN_2)
        self._drop_manifest(self.RUN_2)
        report = self._restore()
        self.assertEqual(report.run_id, self.RUN_1)
        self.assertEqual(report.verified_keys, ["a.jpg"])

    def test_a_copy_that_died_after_its_first_object_is_ignored(self):
        self._backup(self.RUN_1)
        self.store.put("backup", _object_key_for_backup("tenant-a", self.RUN_2, "f" * 64), b"partial")
        self.assertEqual(self._restore().run_id, self.RUN_1)

    def test_only_incomplete_copies_means_nothing_to_restore(self):
        self._backup(self.RUN_1)
        self._drop_manifest(self.RUN_1)
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("no generation with a manifest", str(ctx.exception))

    def test_an_explicit_run_id_for_an_incomplete_copy_is_refused(self):
        self._backup(self.RUN_1)
        self._backup(self.RUN_2)
        self._drop_manifest(self.RUN_2)
        with self.assertRaises(MediaRestoreVerificationError):
            self._restore(run_id=self.RUN_2)

    def test_a_complete_but_unreadable_newest_copy_names_the_older_one(self):
        self._backup(self.RUN_1)
        self._backup(self.RUN_2)
        self.store.put("backup", _manifest_key("tenant-a", self.RUN_2), b"not a manifest")
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn(f"--run-id {self.RUN_1}", str(ctx.exception))
        self.assertEqual(self._restore(run_id=self.RUN_1).run_id, self.RUN_1)

    def test_no_older_copy_says_so(self):
        self._backup(self.RUN_1)
        self.store.put("backup", _manifest_key("tenant-a", self.RUN_1), b"not a manifest")
        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("No older generation", str(ctx.exception))

    def test_the_generation_key_pattern_matches_only_this_tenants_own_shape(self):
        pattern = _generation_key_pattern("tenant-a")
        self.assertIsNotNone(pattern.match(
            "media/tenant-a/generations/20260101T000000000000Z-0000000000000000/objects/"
            + "a" * 64 + ".age"
        ))
        self.assertIsNotNone(pattern.match(
            "media/tenant-a/generations/20260101T000000000000Z-0000000000000000/manifest.json.age"
        ))
        self.assertIsNone(pattern.match("media/tenant-ab/generations/x/manifest.json.age"))
        self.assertIsNone(pattern.match("media/tenant-a/objects/" + "a" * 64 + ".age"))


class MainWiringTests(unittest.TestCase):
    """Proves the CLI's argument parsing actually reaches the function calls
    it claims to, not only that the process exits the right code -- a
    flag silently dropped inside `main()` (for example a hardcoded
    `confirm_tenant_has_no_media=False`) would leave every other test
    green, since none of them exercise `main()`'s own wiring: mock the two
    entry points and assert on the KWARGS `main` passed them, not merely
    on the return code."""

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
        mock_backup.return_value = mock.Mock(
            tenant="t", run_id="r", object_count=1, deliberately_empty=False, deleted_previous_keys=[]
        )
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
        mock_backup.return_value = mock.Mock(
            tenant="t", run_id="r", object_count=0, deliberately_empty=True, deleted_previous_keys=[]
        )
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
        self.assertIsNone(mock_restore.call_args.kwargs["run_id"])

    @mock.patch("media_backup_restore.restore_tenant_media")
    def test_restore_passes_an_explicit_run_id_through(self, mock_restore):
        mock_restore.return_value = mock.Mock(
            tenant="t", run_id="20260101T000000000000Z-0000000000000000",
            verified_keys=["k"], bytes_recovered=5,
        )
        rc = main(
            [
                "restore", "--tenant", "t", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION, "--identity-file", "/tmp/id",
                "--run-id", "20260101T000000000000Z-0000000000000000",
            ]
        )
        self.assertEqual(rc, 0)
        self.assertEqual(
            mock_restore.call_args.kwargs["run_id"], "20260101T000000000000Z-0000000000000000"
        )

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


if __name__ == "__main__":
    unittest.main()

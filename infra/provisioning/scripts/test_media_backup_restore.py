#!/usr/bin/env python3
"""Unit tests for media_backup_restore.py.

No real network here -- `list_objects` / `get_object_with_content_type` /
`get_object` / `put_object` / `delete_object` are injected as fakes, so
these tests pin the module's own logic (the floor, the checksum comparison,
per-tenant isolation, key-opacity, the recipient-count guard, the
generation-based deletion ordering and its concurrency safety) rather than
re-proving the SigV4 signer (`test_objectstorage.py` already does that).
`age` itself IS real in `RecipientStanzaCountTests` -- the count this module
trusts is checked against real `age` output, not only against a value this
file invents -- and in `EncryptWithAgeArgvTests`, which captures the real
argv a fake `run` receives. The full chain -- real MinIO, real Ghost, the
CLI's own exit code, and a live reproduction of a second-recipient
ciphertext -- is proven by `media-backup-restore-proof.sh`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from unittest import mock

from media_backup_restore import (
    MediaBackupClockSkewError,
    MediaBackupConfirmedEmptyConflictError,
    MediaBackupError,
    MediaBackupFloorError,
    MediaBackupManifestVerificationError,
    MediaBackupObjectVerificationError,
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
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
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
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            delete_object=self.store.delete_object,
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


class RecordingObjectStore(FakeObjectStore):
    """Same in-memory store, plus a shared `calls` log of
    `(operation, bucket, key)` for every put/get/delete -- what the
    ordering-sabotage tests below need to prove *when* the delete step ran
    relative to the manifest write and its read-back, not only that it ran
    at all."""

    def __init__(self):
        super().__init__()
        self.calls: list[tuple[str, str, str]] = []

    def put_object(self, *, bucket, key, data, content_type="application/octet-stream", **kw):
        self.calls.append(("put", bucket, key))
        super().put_object(bucket=bucket, key=key, data=data, content_type=content_type, **kw)

    def get_object(self, *, bucket, key, **kw):
        self.calls.append(("get", bucket, key))
        return super().get_object(bucket=bucket, key=key, **kw)

    def delete_object(self, *, bucket, key, **kw):
        self.calls.append(("delete", bucket, key))
        super().delete_object(bucket=bucket, key=key, **kw)


class GenerationRefreshTests(unittest.TestCase):
    """Each run uploads a fresh complete set under a new generation prefix
    and writes that generation's own manifest; only once that manifest is
    written AND read back, AND every object this run wrote is proven
    present in a fresh listing, does an older generation get deleted, with a
    plain DeleteObject that a versioned bucket turns into a delete marker,
    never DeleteObjectVersion. See media_backup_restore.py's module
    docstring for the mechanism and its reasons."""

    def setUp(self):
        self.store = RecordingObjectStore()
        self.store.put(
            "live-a", "content/images/photo.jpg", b"first generation bytes", content_type="image/jpeg",
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
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            delete_object=self.store.delete_object,
            encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def _objects_for(self, tenant="tenant-a", run_id=None):
        prefix = _tenant_generations_prefix(tenant)
        keys = {
            key for key in self.store.buckets.get("backup", {})
            if key.startswith(prefix) and "/objects/" in key
        }
        if run_id is not None:
            keys = {key for key in keys if f"/{run_id}/" in key}
        return keys

    def test_second_run_deletes_the_first_runs_objects(self):
        first = self._backup()
        first_keys = self._objects_for(run_id=first.run_id)
        self.assertEqual(len(first_keys), 1)

        self.store.buckets["live-a"]["content/images/photo.jpg"] = b"second generation bytes"
        second = self._backup()
        second_keys = self._objects_for(run_id=second.run_id)

        self.assertEqual(len(second_keys), 1)
        self.assertNotEqual(first_keys, second_keys, "the second run must use a FRESH generation")
        # The whole first generation is deleted -- its object AND its
        # manifest, since a generation is now its own disjoint prefix.
        self.assertEqual(len(second.deleted_previous_keys), 2)
        self.assertTrue(first_keys.issubset(set(second.deleted_previous_keys)))
        self.assertIn(_manifest_key("tenant-a", first.run_id), second.deleted_previous_keys)
        # The first generation's ciphertext is genuinely gone from the fake
        # store -- not merely absent from the new manifest.
        self.assertFalse(first_keys & second_keys)
        for key in first_keys:
            self.assertNotIn(key, self.store.buckets["backup"])

    def test_storage_is_never_unbounded_across_many_runs(self):
        # Storage claim: about 2x mid-run, never N x.
        for generation in range(5):
            self.store.buckets["live-a"]["content/images/photo.jpg"] = f"gen {generation}".encode()
            report = self._backup()
        self.assertEqual(len(self._objects_for(run_id=report.run_id)), 1)
        self.assertEqual(len(self._objects_for()), 1)

    def test_restore_still_verifies_after_a_second_run(self):
        self._backup()
        self.store.buckets["live-a"]["content/images/photo.jpg"] = b"second generation bytes"
        self._backup()
        del self.store.buckets["live-a"]["content/images/photo.jpg"]
        report = restore_tenant_media(
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
        self.assertEqual(report.verified_keys, ["content/images/photo.jpg"])
        self.assertEqual(report.bytes_recovered, len(b"second generation bytes"))

    def test_sabotage_an_upload_failure_mid_run_leaves_the_previous_set_intact(self):
        # RED: break the second object's upload partway through a run that
        # would otherwise supersede the first generation.
        first = self._backup()
        first_keys = self._objects_for(run_id=first.run_id)
        self.store.buckets["live-a"]["content/images/second.jpg"] = b"a second live object"
        self.store.content_types.setdefault("live-a", {})["content/images/second.jpg"] = "image/jpeg"

        real_put = self.store.put_object
        calls = {"n": 0}

        def flaky_put(**kw):
            calls["n"] += 1
            if calls["n"] == 2:
                raise ObjectStorageError("simulated upload failure mid-run")
            return real_put(**kw)

        with self.assertRaises(ObjectStorageError):
            self._backup(put_object=flaky_put)
        # RED: the old generation must still be exactly what it was -- a
        # failed run may leave an orphaned partial object from ITS OWN
        # attempt behind (the object that uploaded before the failure), but
        # it must never remove or alter anything from the previous
        # generation, and it must never delete anything at all.
        self.assertTrue(first_keys.issubset(self._objects_for()))
        for key in first_keys:
            self.assertIn(key, self.store.buckets["backup"])
        self.assertFalse(any(op == "delete" for op, _, _ in self.store.calls))
        # GREEN: revert (no sabotage) and confirm a clean run still succeeds
        # and still supersedes the original generation.
        second = self._backup()
        self.assertNotEqual(set(second.deleted_previous_keys), set())

    def test_sabotage_a_manifest_readback_mismatch_prevents_deletion(self):
        # RED: the manifest PUT "succeeds" (2xx) but what is actually stored
        # differs from what was sent -- exactly the failure mode a 2xx alone
        # cannot rule out. Deletion must not run.
        first = self._backup()
        first_keys = self._objects_for(run_id=first.run_id)
        self.store.buckets["live-a"]["content/images/photo.jpg"] = b"second generation bytes"

        real_put = self.store.put_object

        def corrupting_put(**kw):
            if kw["key"].endswith("manifest.json.age"):
                kw = dict(kw)
                kw["data"] = kw["data"] + b"\x00tampered-in-flight"
            return real_put(**kw)

        with self.assertRaises(MediaBackupManifestVerificationError):
            self._backup(put_object=corrupting_put)
        self.assertTrue(
            first_keys.issubset(self._objects_for()), "deletion must not run on an unverified manifest"
        )
        self.assertFalse(any(op == "delete" for op, _, _ in self.store.calls))
        # GREEN: a clean run (no sabotage) still supersedes the first
        # generation normally -- and also cleans up the orphan the
        # sabotaged run's own partial upload left behind, since that orphan
        # is, by the same "older generation" rule, superseded too.
        second = self._backup()
        self.assertTrue(first_keys.issubset(set(second.deleted_previous_keys)))
        self.assertEqual(len(self._objects_for()), 1, "only the latest generation should remain")

    def test_delete_never_precedes_the_manifest_write_and_its_readback(self):
        # The CLI's own ordering guarantee, proven through the real function
        # rather than asserted from the source: every "delete" call in the
        # recorded order must come after BOTH the manifest "put" and the
        # manifest "get" (the read-back) that verifies it.
        first = self._backup()
        self.store.buckets["live-a"]["content/images/photo.jpg"] = b"second generation bytes"
        self.store.calls.clear()
        second = self._backup()

        manifest_key = _manifest_key("tenant-a", second.run_id)
        put_index = next(
            i for i, (op, bucket, key) in enumerate(self.store.calls)
            if op == "put" and bucket == "backup" and key == manifest_key
        )
        get_index = next(
            i for i, (op, bucket, key) in enumerate(self.store.calls)
            if op == "get" and bucket == "backup" and key == manifest_key
        )
        delete_indices = [i for i, (op, *_r) in enumerate(self.store.calls) if op == "delete"]
        self.assertTrue(delete_indices, "this run should have deleted the previous generation")
        self.assertTrue(
            all(i > put_index and i > get_index for i in delete_indices),
            f"a delete ran before the manifest write/read-back: calls={self.store.calls}",
        )
        del first  # only used to seed the first generation

    def test_a_truncated_live_listing_never_reaches_deletion(self):
        first = self._backup()
        first_keys = self._objects_for(run_id=first.run_id)

        def truncated_listing(**_kw):
            raise ObjectStorageError(
                "GET live-a?list-type=2: IsTruncated=true but no NextContinuationToken"
            )

        with self.assertRaises(ObjectStorageError):
            self._backup(list_objects=truncated_listing)
        self.assertEqual(self._objects_for(), first_keys)
        self.assertFalse(any(op == "delete" for op, _, _ in self.store.calls))

    def test_tenant_isolation_a_prefix_sharing_tenant_name_is_never_touched(self):
        # tenant-a and tenant-ab: "tenant-a" is a string-prefix of
        # "tenant-ab", but "media/tenant-a/generations/" is not a
        # string-prefix of "media/tenant-ab/generations/..." because
        # "generations/" immediately follows the tenant name in every key
        # this module writes.
        self._backup()  # tenant-a, generation 1
        self.store.put("live-ab", "content/images/only-ab.jpg", b"tenant-ab's own bytes")
        ab = self._backup(tenant="tenant-ab", live_bucket="live-ab", recipient=TENANT_B_RECIPIENT)
        ab_keys = self._objects_for("tenant-ab", run_id=ab.run_id)
        self.assertEqual(len(ab_keys), 1)

        # A second run for tenant-a alone must delete only tenant-a's first
        # generation, never anything under tenant-ab's prefix.
        self.store.buckets["live-a"]["content/images/photo.jpg"] = b"tenant-a generation 2"
        second = self._backup()
        self.assertEqual(set(second.deleted_previous_keys) & ab_keys, set())
        self.assertEqual(self._objects_for("tenant-ab"), ab_keys)
        for key in ab_keys:
            self.assertIn(key, self.store.buckets["backup"])

    def test_deletion_uses_plain_delete_never_a_version_scoped_one(self):
        # The workload credential is fenced from DeleteObjectVersion (see
        # db/provision/configure_backup_bucket.py's fence and this module's
        # module docstring) -- `delete_object` is called with no
        # version-identifying argument at all, so it cannot even express
        # one. Assert that directly (no delete call carries a
        # `version_id`), not merely that some delete happened.
        self._backup()
        self.store.buckets["live-a"]["content/images/photo.jpg"] = b"second generation bytes"
        self.store.calls.clear()

        captured_kwargs: list[dict] = []
        real_delete = self.store.delete_object

        def recording_delete(**kw):
            captured_kwargs.append(kw)
            return real_delete(**kw)

        self._backup(delete_object=recording_delete)
        self.assertTrue(captured_kwargs, "this run should have deleted the previous generation")
        for kw in captured_kwargs:
            self.assertNotIn("version_id", kw)
            self.assertNotIn("versionId", kw)


class ConfirmedEmptyConflictTests(unittest.TestCase):
    """`--confirm-tenant-has-no-media` must never be able to delete a
    previous generation that actually holds objects -- it exists for a
    brand-new tenant with no previous generation, never to empty one that
    exists."""

    def setUp(self):
        self.store = RecordingObjectStore()

    def _backup(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_sabotage_confirmed_empty_against_a_populated_previous_generation_is_refused(self):
        # RED: a populated first
        # generation exists; a confirmed-empty run must not be able to
        # delete it.
        self.store.put("live-a", "a.jpg", b"a bytes")
        first = self._backup()
        self.store.buckets["live-a"].clear()
        self.store.calls.clear()
        with self.assertRaises(MediaBackupConfirmedEmptyConflictError):
            self._backup(confirm_tenant_has_no_media=True)
        # GREEN: nothing was deleted, and the previous generation's objects
        # are exactly as they were.
        self.assertFalse(any(op == "delete" for op, _, _ in self.store.calls))
        self.assertEqual(len(first.objects), 1)
        for key in self.store.buckets["backup"]:
            if "/objects/" in key:
                self.assertIn(f"/{first.run_id}/", key)

    def test_confirm_empty_is_allowed_with_no_previous_generation_at_all(self):
        # A brand-new tenant: the flag's actual intended use.
        report = self._backup(confirm_tenant_has_no_media=True)
        self.assertTrue(report.deliberately_empty)
        self.assertEqual(report.object_count, 0)

    def test_confirm_empty_is_allowed_when_the_previous_generation_was_itself_empty(self):
        # Superseding one deliberately-empty generation with another must
        # stay possible -- only a POPULATED previous generation is refused.
        self._backup(confirm_tenant_has_no_media=True)
        second = self._backup(confirm_tenant_has_no_media=True)
        self.assertTrue(second.deliberately_empty)


class ObjectLandedVerificationTests(unittest.TestCase):
    """An object PUT that answers 2xx without actually persisting must
    not reach the delete step -- caught by a fresh listing, taken right
    before any delete, that every object this run itself wrote is present
    in."""

    def setUp(self):
        self.store = RecordingObjectStore()
        self.store.put("live-a", "a.jpg", b"a bytes")
        self.store.put("live-a", "b.jpg", b"b bytes")

    def _backup(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_sabotage_a_2xx_put_that_never_actually_stored_the_object_is_caught(self):
        # RED: a `put_object` that
        # drops the SECOND object's ciphertext silently (no exception, no
        # non-2xx status -- exactly the failure the module's own real 2xx
        # cannot rule out) while succeeding for everything else, including
        # the manifest.
        first = self._backup()
        first_object_keys = {
            key for key in self.store.buckets["backup"]
            if f"/{first.run_id}/" in key and "/objects/" in key
        }
        self.assertEqual(len(first_object_keys), 2)
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"
        self.store.buckets["live-a"]["b.jpg"] = b"b bytes v2"

        real_put = self.store.put_object
        dropped = {"done": False}

        def lossy_put(**kw):
            if not dropped["done"] and "/objects/" in kw["key"] and kw["key"].endswith(".age"):
                dropped["done"] = True
                return  # 2xx in spirit -- no exception -- but never stored
            return real_put(**kw)

        self.store.calls.clear()
        with self.assertRaises(MediaBackupObjectVerificationError) as ctx:
            self._backup(put_object=lossy_put)
        self.assertIn("not present", str(ctx.exception))
        # GREEN (still within the RED case): nothing was deleted, and the
        # previous generation is completely untouched -- every one of its
        # object keys is still exactly where it was.
        self.assertFalse(any(op == "delete" for op, _, _ in self.store.calls))
        self.assertTrue(first_object_keys.issubset(self.store.buckets["backup"].keys()))

        # GREEN: revert (no sabotage) -- a clean run succeeds and supersedes
        # the first generation as normal.
        second = self._backup()
        self.assertEqual(second.object_count, 2)
        self.assertTrue(set(second.deleted_previous_keys))


class ConcurrentRunSafetyTests(unittest.TestCase):
    """Two runs of the same tenant overlapping in time must never leave
    the tenant's current (highest-run-id) generation unrestorable, and must
    never delete a still-current generation out from under it. See the
    module docstring's "GENERATIONS, THE ORDERING GUARANTEE" section --
    these tests prove both orderings it describes, deterministically, by
    injecting explicit run ids rather than relying on wall-clock timing."""

    def setUp(self):
        self.store = FakeObjectStore()
        for key in ("a.jpg", "b.jpg", "c.jpg"):
            self.store.put("live-a", key, key.encode())

    def _backup(self, run_id, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
            make_run_id=lambda: run_id,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def _restore(self):
        return restore_tenant_media(
            tenant="tenant-a", backup_bucket="backup", endpoint=ENDPOINT, region=REGION,
            backup_access_key="x", backup_secret_key="x", identity_path=TENANT_A_IDENTITY,
            list_objects=self.store.list_objects, get_object=self.store.get_object,
            put_object=self.store.put_object, decrypt=_fake_decrypt(IDENTITY_TO_RECIPIENT),
        )

    # Two fixed, validly-shaped run ids -- SMALL sorts before LARGE.
    SMALL_RUN_ID = "20260101T000000000000Z-0000000000000001"
    LARGE_RUN_ID = "20260101T000000000000Z-ffffffffffffffff"

    def test_sequential_smaller_id_then_larger_id_supersedes_in_id_order(self):
        # Not an interleaving -- both runs complete fully, one after the
        # other, with no overlap in time. Proves the ordinary case: a run
        # can only ever delete generations older than ITSELF, so id order
        # alone determines what a later run supersedes, whichever order the
        # runs actually started in. See the two tests below for the cases
        # where the runs' UPLOADS genuinely overlap.
        # A gen0 exists first.
        self._backup("20260101T000000000000Z-0000000000000000")

        # The run with the SMALLER of the two new ids (started "earlier")
        # runs to completion first, entirely, while the LARGER-id run has
        # not started yet. This is the ordinary case: the smaller id can
        # only ever delete generations older than ITSELF, so it never
        # touches the larger-id run either way.
        small = self._backup(self.SMALL_RUN_ID)
        # gen0's 3 objects PLUS its manifest -- a whole generation, not just
        # the objects/ half of it, since a generation is now its own prefix.
        self.assertEqual(len(small.deleted_previous_keys), 4, "gen0 should be superseded")

        # The LARGER-id run now finishes too, later. It supersedes the
        # smaller-id run's now-complete generation.
        large = self._backup(self.LARGE_RUN_ID)
        self.assertEqual(len(large.deleted_previous_keys), 4, "the smaller-id generation should be superseded")

        report = self._restore()
        self.assertEqual(len(report.verified_keys), 3)

    def test_interleaving_2_the_larger_id_run_finishes_first_while_the_smaller_id_run_is_mid_upload(self):
        # RED (the dangerous case): a run with the LARGER
        # id runs to completion -- including its own delete step -- WHILE a
        # run with the SMALLER id is still mid-upload, having already
        # written some of its own objects under its own (smaller, "older")
        # generation prefix. Those objects are fair game for the
        # larger-id run's cleanup (its id sorts after them), so they are
        # deleted out from under the smaller-id run before it finishes.
        state = {"fired": False}
        real_put = self.store.put_object

        def small_run_put_hook(**kw):
            real_put(**kw)
            if not state["fired"] and "/objects/" in kw["key"] and f"/{self.SMALL_RUN_ID}/" in kw["key"]:
                state["fired"] = True
                # The larger-id run starts and finishes ENTIRELY while the
                # smaller-id run is paused here, mid-upload.
                large_report = self._backup(self.LARGE_RUN_ID)
                state["large_report"] = large_report

        with self.assertRaises(MediaBackupObjectVerificationError):
            self._backup(self.SMALL_RUN_ID, put_object=small_run_put_hook)

        # GREEN: the larger-id (finished-first) run is intact and fully
        # restorable -- restore succeeds and recovers every object.
        report = self._restore()
        self.assertEqual(len(report.verified_keys), 3)
        # The smaller-id (slower) run raised before it reached its own
        # delete step -- it deleted nothing. It also never reached its own
        # manifest write: the presence check that catches its missing
        # object runs BEFORE that run's manifest is written, so a run
        # whose own objects got superseded out from under it leaves no
        # manifest of its own behind either -- only the winner's.
        remaining_manifests = [
            key for key in self.store.buckets["backup"] if key.endswith("manifest.json.age")
        ]
        self.assertEqual(len(remaining_manifests), 1, "only the winning (larger-id) run's manifest should exist")

    def test_true_interleaving_the_smaller_id_run_never_deletes_the_larger_id_runs_in_progress_objects(self):
        # The rule that makes concurrent runs safe -- "never delete a
        # same-or-later generation" (`_sorts_before`, used by
        # `_delete_older_generations` for both the end-of-run delete AND
        # the orphan sweep below) -- proven by TRUE interleaving, not
        # merely sequential completion: the LARGER-id run is paused mid-upload,
        # and while it is paused, the SMALLER-id run starts AND completes
        # its whole backup, including its own delete/orphan-sweep step.
        # The smaller-id run's cleanup must never remove the larger-id
        # run's already-written object, because a same-or-later id is
        # never "older" -- regardless of which run happens to finish
        # first in wall-clock time.
        state = {"fired": False, "large_object_key": None}
        real_put = self.store.put_object

        def large_run_put_hook(**kw):
            real_put(**kw)
            if not state["fired"] and "/objects/" in kw["key"] and f"/{self.LARGE_RUN_ID}/" in kw["key"]:
                state["fired"] = True
                state["large_object_key"] = kw["key"]
                # The SMALLER-id run starts and finishes ENTIRELY -- upload,
                # presence checks, manifest, delete step -- while the
                # LARGER-id run is paused right here, mid-upload.
                self._backup(self.SMALL_RUN_ID)

        try:
            large = self._backup(self.LARGE_RUN_ID, put_object=large_run_put_hook)
        except MediaBackupObjectVerificationError:
            # Under a broken guard, the larger run's OWN presence check can
            # itself be the thing that catches the corruption (its own
            # object missing) -- that is still a symptom of the same bug,
            # not a separate outcome, so this is caught here rather than
            # asserted against directly: the assertion below is the one
            # that actually distinguishes correct code from broken code.
            large = None

        self.assertIn(
            state["large_object_key"],
            self.store.buckets["backup"],
            "the smaller-id run's cleanup deleted a still-in-progress larger-id run's own "
            "object -- a same-or-later id must never be treated as \"older\"",
        )
        if large is not None:
            self.assertEqual(large.object_count, 3)
            report = self._restore()
            self.assertEqual(len(report.verified_keys), 3)

    def test_nested_run_completes_entirely_during_the_outer_runs_upload(self):
        # Uses the real (wall-clock) generate_run_id rather than injected
        # ids: an outer run ("B") starts uploading; the first time it
        # writes an object, a second, nested run ("A") is triggered and
        # runs to completion -- entirely -- before the outer run resumes.
        # Whatever the two runs' real ids end up being, the invariant this
        # proves is order-agnostic: after both finish (or the slower one
        # safely aborts), restore succeeds and recovers every object the
        # winning generation's manifest names.
        state = {"fired": False}
        real_put = self.store.put_object

        def outer_put_hook(**kw):
            real_put(**kw)
            if not state["fired"] and "/objects/" in kw["key"]:
                state["fired"] = True
                self._backup(None, make_run_id=generate_run_id)

        outer_ok = True
        try:
            self._backup(None, put_object=outer_put_hook, make_run_id=generate_run_id)
        except MediaBackupObjectVerificationError:
            outer_ok = False  # the slower run safely lost the race -- expected, not a bug

        report = self._restore()
        self.assertEqual(len(report.verified_keys), 3)
        del outer_ok  # documents the branch; the restore assertion above is what matters


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
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            delete_object=self.store.delete_object,
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
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            delete_object=self.store.delete_object,
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
            get_object=self.store.get_object,
            put_object=self.store.put_object,
            delete_object=self.store.delete_object,
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
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
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

    def test_a_lossy_put_run_leaves_the_previous_generation_as_the_default_restore_target(self):
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"

        real_put = self.store.put_object
        dropped = {"done": False}

        def lossy_put(**kw):
            if not dropped["done"] and "/objects/" in kw["key"] and kw["key"].endswith(".age"):
                dropped["done"] = True
                return  # 2xx in spirit -- no exception -- but never stored
            return real_put(**kw)

        with self.assertRaises(MediaBackupObjectVerificationError):
            self._backup(put_object=lossy_put)

        # No manifest was ever written for the lossy run -- a manifest
        # means a complete generation, so a failure caught before it is
        # written leaves none behind for the failed run.
        manifests = [k for k in self.store.buckets["backup"] if k.endswith("manifest.json.age")]
        self.assertEqual(manifests, [_manifest_key("tenant-a", good.run_id)])

        report = self._restore()
        self.assertEqual(report.run_id, good.run_id)
        self.assertEqual(report.verified_keys, ["a.jpg"])

    def test_a_manifest_readback_mismatch_names_the_older_generation_and_the_run_id_command(self):
        good = self._backup()
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"

        real_put = self.store.put_object

        def corrupting_put(**kw):
            if kw["key"].endswith("manifest.json.age"):
                kw = dict(kw)
                kw["data"] = kw["data"][:-5]  # the PUT "succeeds"; the stored bytes differ
            return real_put(**kw)

        with self.assertRaises(MediaBackupManifestVerificationError):
            self._backup(put_object=corrupting_put)

        # Despite the raise, the corrupted manifest key DOES now exist and
        # sorts newest -- this is the one failure the reordering alone
        # cannot prevent (see the module docstring).
        manifests = {k for k in self.store.buckets["backup"] if k.endswith("manifest.json.age")}
        self.assertEqual(len(manifests), 2)

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        message = str(ctx.exception)
        self.assertIn(good.run_id, message)
        self.assertIn(f"--run-id {good.run_id}", message)

        # The explicit --run-id recovery this message names actually works
        # -- never chosen automatically, only on request.
        recovered = self._restore(run_id=good.run_id)
        self.assertEqual(recovered.run_id, good.run_id)
        self.assertEqual(recovered.verified_keys, ["a.jpg"])

    def test_no_older_generation_says_so_rather_than_inventing_a_run_id(self):
        real_put = self.store.put_object

        def corrupting_put(**kw):
            if kw["key"].endswith("manifest.json.age"):
                kw = dict(kw)
                kw["data"] = kw["data"][:-5]
            return real_put(**kw)

        with self.assertRaises(MediaBackupManifestVerificationError):
            self._backup(put_object=corrupting_put)

        with self.assertRaises(MediaRestoreVerificationError) as ctx:
            self._restore()
        self.assertIn("No older generation", str(ctx.exception))

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


class KeyShapeDeletionGuardTests(unittest.TestCase):
    """Every key a listing returns under a tenant's
    `generations/` prefix is checked against this module's own exact key
    shape before it is trusted for either the presence check or the delete
    decision -- so a listing that returned something outside that shape
    (a bug elsewhere, a forged object, a `prefix` argument silently ignored)
    aborts the run rather than being silently included or excluded."""

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
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_sabotage_an_unexpected_key_under_the_tenant_prefix_aborts_rather_than_being_silently_handled(self):
        # RED: simulate a listing bug (or a stray write from elsewhere)
        # that returns a key under this tenant's own generations/ prefix
        # but NOT matching this module's exact per-run shape.
        self._backup()
        self.store.buckets["backup"]["media/tenant-a/generations/not-a-real-run-id/objects/junk"] = b"x"
        with self.assertRaises(MediaBackupError) as ctx:
            self._backup()
        self.assertIn("does not match this module's own key shape", str(ctx.exception))
        # GREEN: revert (remove the injected stray key) -- a clean run
        # succeeds normally again.
        del self.store.buckets["backup"]["media/tenant-a/generations/not-a-real-run-id/objects/junk"]
        report = self._backup()
        self.assertEqual(report.object_count, 1)

    def test_generation_key_pattern_matches_only_this_tenants_own_shape(self):
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

    def test_a_persistent_bad_key_fails_before_any_object_is_re_uploaded(self):
        # The shape check that would abort this run anyway (see the
        # sabotage test above) now runs BEFORE any object is re-uploaded --
        # a persistent version of this failure must cost one listing per
        # run, never a full new copy of the tenant's media every time it
        # recurs.
        self._backup()
        self.store.buckets["backup"]["media/tenant-a/generations/not-a-real-run-id/objects/junk"] = b"x"
        before = {key for key in self.store.buckets["backup"] if "/objects/" in key}
        with self.assertRaises(MediaBackupError):
            self._backup()
        after = {key for key in self.store.buckets["backup"] if "/objects/" in key}
        self.assertEqual(
            before, after, "a persistent shape defect must not upload a full new copy before failing"
        )


class OrphanGenerationCleanupTests(unittest.TestCase):
    """An orphaned generation (objects with no manifest -- an aborted
    or a superseded-while-still-uploading run) that is strictly older than
    this run's own id is reclaimed before this run uploads anything, using
    the same "never a same-or-later id" rule as every other delete in this
    module (`_sorts_before`). Reclaiming it here, rather than only as a
    side effect of a run that itself goes on to succeed, means a run that
    fails for an unrelated reason still does not leave a previous run's
    abandoned objects sitting there indefinitely."""

    def setUp(self):
        self.store = RecordingObjectStore()
        self.store.put("live-a", "a.jpg", b"a bytes")

    def _backup(self, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_an_orphan_older_than_this_run_is_reclaimed_even_when_this_run_itself_then_fails(self):
        # An orphan from a previous run that uploaded one object then never
        # wrote a manifest at all (a crash, or a lost race) -- older than a
        # generation that DOES have a manifest in the same listing, which is
        # what makes it safe to reclaim: it can never become the tenant's
        # newest restorable generation, because a newer, already-complete
        # one already exists in this same snapshot.
        orphan_run_id = "20260101T000000000000Z-0000000000000000"
        orphan_key = _object_key_for_backup("tenant-a", orphan_run_id, "a" * 64)
        self.store.put("backup", orphan_key, b"orphaned ciphertext")

        # A real, manifested generation, newer than the orphan above.
        self._backup(make_run_id=lambda: "20260102T000000000000Z-0000000000000000")

        # This run is made to fail for an UNRELATED reason -- an upload
        # failure partway through its own object loop -- which happens
        # AFTER the orphan sweep at the top of the function has already
        # run.
        def flaky_put(**kw):
            raise ObjectStorageError("simulated upload failure")

        with self.assertRaises(ObjectStorageError):
            self._backup(put_object=flaky_put, make_run_id=lambda: "20260103T000000000000Z-0000000000000000")

        self.assertNotIn(orphan_key, self.store.buckets["backup"])

    def test_a_run_that_completes_before_a_stale_sweeps_deletes_land_must_survive(self):
        # G0 is a good, manifested generation. Run
        # A uploads its one object -- no manifest yet -- and pauses right
        # there. Run B starts: it lists the tenant's prefix at that exact
        # moment (G0 has a manifest; A does not, so a stale-snapshot sweep
        # could still count A as an orphan), then fails on its own live
        # read before it ever uploads or writes a manifest of its own --
        # but its sweep's delete calls were already issued against that
        # stale listing, and this test applies them only AFTER A has
        # resumed, passed both its presence checks, written its manifest,
        # and deleted G0 -- modelling those deletes landing on the wire
        # late. The tenant must still be restorable afterwards.
        g0_run_id = "20260101T000000000000Z-0000000000000000"
        a_run_id = "20260102T000000000000Z-0000000000000000"
        b_run_id = "20260103T000000000000Z-0000000000000000"

        self._backup(make_run_id=lambda: g0_run_id)  # G0
        self.store.buckets["live-a"]["a.jpg"] = b"a bytes v2"

        deferred_b_deletes = []
        state = {"fired": False}
        real_put = self.store.put_object

        def b_delete_hook(**kw):
            deferred_b_deletes.append(kw)

        def b_live_read_fails(**kw):
            raise ObjectStorageError("live read failed")

        def a_put_hook(**kw):
            real_put(**kw)
            if not state["fired"] and "/objects/" in kw["key"] and f"/{a_run_id}/" in kw["key"]:
                state["fired"] = True
                # Run B starts here, while A's object is uploaded but A has
                # written no manifest. B's own sweep runs against exactly
                # this listing; B then fails before writing anything of
                # its own.
                with self.assertRaises(ObjectStorageError):
                    self._backup(
                        make_run_id=lambda: b_run_id,
                        delete_object=b_delete_hook,
                        get_object_with_content_type=b_live_read_fails,
                    )

        self._backup(put_object=a_put_hook, make_run_id=lambda: a_run_id)

        # The fix's own proof: B's stale listing must never have queued a
        # delete for any of A's objects in the first place.
        self.assertFalse(
            any(f"/{a_run_id}/" in d["key"] for d in deferred_b_deletes),
            "B's sweep must never target A's objects from a listing that predates A's manifest",
        )

        # Apply whatever B's sweep DID queue (nothing, once fixed) now that
        # A has already completed and deleted G0 -- modelling deletes that
        # were computed from a stale listing landing on the wire late.
        for kw in deferred_b_deletes:
            self.store.delete_object(**kw)

        report = restore_tenant_media(
            tenant="tenant-a", backup_bucket="backup", endpoint=ENDPOINT, region=REGION,
            backup_access_key="x", backup_secret_key="x", identity_path=TENANT_A_IDENTITY,
            list_objects=self.store.list_objects, get_object=self.store.get_object,
            put_object=self.store.put_object, decrypt=_fake_decrypt(IDENTITY_TO_RECIPIENT),
        )
        self.assertEqual(report.verified_keys, ["a.jpg"])

    def test_an_orphan_newer_than_this_run_is_left_alone(self):
        # A same-or-later id is never "older" -- an orphan from a
        # still-in-progress concurrent run with a NEWER id must survive
        # this run's own sweep.
        newer_orphan_run_id = "29990101T000000000000Z-0000000000000000"
        orphan_key = _object_key_for_backup("tenant-a", newer_orphan_run_id, "b" * 64)
        self.store.put("backup", orphan_key, b"in-progress ciphertext")

        self._backup()

        self.assertIn(orphan_key, self.store.buckets["backup"])

    def test_sabotage_the_shared_ordering_predicate_breaks_the_orphan_sweep_too(self):
        # The orphan sweep shares `_delete_older_generations` /
        # `_sorts_before` with the end-of-run supersession delete -- the
        # same `<` -> `!=` sabotage that breaks the end-of-run delete
        # makes this run reclaim an orphan that is NEWER than itself,
        # which is exactly the corruption the shared predicate exists to
        # prevent.
        import media_backup_restore as m

        newer_orphan_run_id = "29990101T000000000000Z-0000000000000000"
        orphan_key = _object_key_for_backup("tenant-a", newer_orphan_run_id, "b" * 64)
        self.store.put("backup", orphan_key, b"in-progress ciphertext")

        original = m._sorts_before
        m._sorts_before = lambda candidate, run_id: candidate != run_id
        try:
            self._backup()
        finally:
            m._sorts_before = original

        self.assertNotIn(orphan_key, self.store.buckets["backup"])


class ClockSkewGuardTests(unittest.TestCase):
    """A generation dated in the future must not let restore silently
    freeze on stale data while every signal stays green. A run whose own
    delete step leaves a newer-sorting manifest behind (this run's clock is
    behind that generation's, or that generation's clock ran ahead of real
    time) must say so loudly -- nothing else in this module ever would.
    This run's own backup is not lost; it is simply not the one restore
    will read."""

    def setUp(self):
        self.store = FakeObjectStore()
        self.store.put("live-a", "a.jpg", b"v1")

    def _backup(self, run_id, **overrides):
        kwargs = dict(
            tenant="tenant-a", live_bucket="live-a", backup_bucket="backup", endpoint=ENDPOINT,
            region=REGION, live_access_key="x", live_secret_key="x", backup_access_key="x",
            backup_secret_key="x", recipient=TENANT_A_RECIPIENT,
            list_objects=self.store.list_objects,
            get_object_with_content_type=self.store.get_object_with_content_type,
            get_object=self.store.get_object, put_object=self.store.put_object,
            delete_object=self.store.delete_object, encrypt=_fake_encrypt,
            make_run_id=lambda: run_id,
        )
        kwargs.update(overrides)
        return backup_tenant_media(**kwargs)

    def test_a_future_dated_generation_is_caught_by_a_normal_runs_own_re_list(self):
        future_run_id = "20990101T000000000000Z-0000000000000000"
        self._backup(future_run_id)
        self.store.buckets["live-a"]["a.jpg"] = b"v2"

        normal_run_id = "20260925T000000000000Z-0000000000000000"
        with self.assertRaises(MediaBackupClockSkewError) as ctx:
            self._backup(normal_run_id)
        self.assertIn(future_run_id, str(ctx.exception))

        # GREEN: the normal run's own backup is NOT lost -- only restore's
        # choice of "newest" is affected until a later-dated run supersedes
        # the future one too.
        self.assertTrue(
            any(f"/{normal_run_id}/" in key for key in self.store.buckets["backup"]),
            "the normal run's own backup must still exist despite the loud failure",
        )

    def test_no_future_generation_means_no_raise(self):
        report = self._backup("20260925T000000000000Z-0000000000000000")
        self.assertEqual(report.object_count, 1)


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

    @mock.patch("media_backup_restore.backup_tenant_media")
    def test_backup_exits_1_when_confirmed_empty_conflicts_with_a_populated_generation(self, mock_backup):
        mock_backup.side_effect = MediaBackupConfirmedEmptyConflictError("populated previous generation")
        rc = main(
            [
                "backup", "--tenant", "t", "--live-bucket", "lb", "--backup-bucket", "bb",
                "--endpoint", ENDPOINT, "--region", REGION, "--confirm-tenant-has-no-media",
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

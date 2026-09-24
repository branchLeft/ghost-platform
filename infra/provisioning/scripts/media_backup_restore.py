#!/usr/bin/env python3
"""Back up one tenant's live media to the backup bucket, and restore it back
-- proving the *bytes*, not that the objects merely exist.

09-backup-and-recovery.html's own control (a Ghost pointed at an empty
database serves HTTP 200) is the reason this module never treats "the GET
succeeded" as "the restore worked". `restore_tenant_media` decrypts every
object the tenant's manifest names and compares its SHA-256 against the
digest `backup_tenant_media` recorded at backup time -- an object that is
missing, corrupt, or encrypted to a different tenant's recipient fails the
comparison and raises, rather than reporting a restore that silently
recovered nothing.

Custody mirrors the database dump exactly, because it is the same
crypto-shredding invariant applied to a second dataset: one `age` recipient
per tenant, never a second one, on both the ciphertext objects and the
manifest that names them. Destroying that tenant's identity makes every
object this module wrote unreadable and leaves every other tenant's objects
untouched -- `restore_tenant_media` never falls back to a different key, and
a caller that hands it the wrong tenant's identity gets `age`'s own refusal
("no identity matched any of the recipients"), not a wrong answer.

Fails closed per tenant, never per run: one tenant's missing object, corrupt
ciphertext or empty live bucket raises for that tenant alone and never
touches another tenant's backup or restore.

Layout in the backup bucket, under a `media/<tenant>/` prefix so a tenant's
media backup can never collide with another tenant's or with the database
dumps sharing the same bucket:
  media/<tenant>/<live object key>.age  -- one ciphertext object per source
  media/<tenant>/manifest.json.age      -- {tenant, objects: {key: {sha256, size}}}

The manifest is itself encrypted to the tenant's recipient, for the same
reason the ciphertext objects are: an object key is an uploaded filename, and
nothing about verifying a restore requires that being legible to anyone who
can read the backup bucket's listing.

`assert_media_present` is the floor this pipeline asserts on itself, the
same shape as `dump_tenant.py`'s row-count floor on `users`/`settings`: a
valid, correctly encrypted, empty backup is the worst possible outcome,
because everything downstream of it looks healthy. Media has no table that
is always non-empty to check against, so the floor is asserted by the
caller, from what it already knows about the tenant, rather than discovered
in the data.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shared_objectstorage import (  # noqa: E402
    ObjectStorageError,
    get_object as _default_get_object,
    list_objects as _default_list_objects,
    put_object as _default_put_object,
)

MEDIA_PREFIX = "media"


class MediaBackupError(Exception):
    """A stage of the media backup did not complete."""


class MediaBackupFloorError(MediaBackupError):
    """The tenant is known to have live media, and the backup captured none.

    Distinguished from `MediaBackupError` so a caller (and a test) can tell
    "something failed" apart from "this specific, self-asserted floor was
    not met" -- the failure shape R4 exists to prevent for media specifically.
    """


class MediaRestoreVerificationError(Exception):
    """A restored object's bytes could not be shown to match the backup --
    missing, corrupt, or undecryptable with the identity given. Never
    swallowed: raised on the FIRST such object, because a restore that
    reports partial success is a restore that reports success, and R4 is
    the reason that is not good enough for media either."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _object_key_for_backup(tenant: str, live_key: str) -> str:
    """The backup bucket's key for one live object -- refuses anything that
    is not a plain, forward-relative path. A `../` segment or a leading `/`
    in an object key would let a crafted upload write outside the tenant's
    own `media/<tenant>/` prefix in the backup bucket; Ghost's own
    `S3Storage.buildKey` already refuses that on the way in, but this
    pipeline does not trust the live bucket's listing to have been produced
    by code that still does."""
    if live_key.startswith("/") or ".." in live_key.split("/"):
        raise MediaBackupError(f"refusing an unsafe live object key: {live_key!r}")
    return f"{MEDIA_PREFIX}/{tenant}/{live_key}.age"


def _manifest_key(tenant: str) -> str:
    return f"{MEDIA_PREFIX}/{tenant}/manifest.json.age"


def encrypt_with_age(*, data: bytes, recipient: str, run=subprocess.run) -> bytes:
    """Encrypts `data` to exactly one recipient. A second `-r` here would be
    the same defect 09-backup-and-recovery.html names for the database dump:
    every test green, erasure silently no longer possible for this tenant's
    media -- so this function accepts exactly one `recipient` string, not a
    list, and there is no parameter shape that could carry a second one."""
    result = run(["age", "-r", recipient], input=data, capture_output=True, check=False)
    if result.returncode != 0:
        raise MediaBackupError(
            f"age encrypt exited {result.returncode}: {result.stderr.decode(errors='replace')}"
        )
    return result.stdout


def decrypt_with_age(*, data: bytes, identity_path: str, run=subprocess.run) -> bytes:
    result = run(
        ["age", "--decrypt", "-i", identity_path], input=data, capture_output=True, check=False
    )
    if result.returncode != 0:
        raise MediaRestoreVerificationError(
            f"age decrypt exited {result.returncode}: {result.stderr.decode(errors='replace')}"
        )
    return result.stdout


@dataclasses.dataclass
class BackupReport:
    tenant: str
    objects: dict[str, dict]

    @property
    def object_count(self) -> int:
        return len(self.objects)


def backup_tenant_media(
    *,
    tenant: str,
    live_bucket: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    live_access_key: str,
    live_secret_key: str,
    backup_access_key: str,
    backup_secret_key: str,
    recipient: str,
    assert_media_present: bool,
    list_objects=_default_list_objects,
    get_object=_default_get_object,
    put_object=_default_put_object,
    encrypt=encrypt_with_age,
) -> BackupReport:
    """Pulls every object in `live_bucket`, encrypts each to `recipient`, and
    writes the ciphertext plus an encrypted manifest to `backup_bucket`.
    Returns before writing anything if `assert_media_present` is set and the
    live bucket is empty -- see the module docstring for why that floor
    exists and why it is the caller's to assert."""
    live_objects = list_objects(
        bucket=live_bucket,
        endpoint=endpoint,
        region=region,
        access_key=live_access_key,
        secret_key=live_secret_key,
    )

    if assert_media_present and not live_objects:
        raise MediaBackupFloorError(
            f"tenant {tenant!r} is known to have live media, but {live_bucket!r} listed "
            f"zero objects -- refusing to write an empty manifest that would look "
            f"identical to a healthy backup of a tenant with nothing uploaded"
        )

    manifest_objects: dict[str, dict] = {}
    for entry in live_objects:
        key = entry["key"]
        data = get_object(
            bucket=live_bucket,
            endpoint=endpoint,
            region=region,
            access_key=live_access_key,
            secret_key=live_secret_key,
            key=key,
        )
        digest = sha256_hex(data)
        ciphertext = encrypt(data=data, recipient=recipient)
        put_object(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            key=_object_key_for_backup(tenant, key),
            data=ciphertext,
        )
        manifest_objects[key] = {"sha256": digest, "size": len(data)}

    manifest = {"tenant": tenant, "objects": manifest_objects, "object_count": len(manifest_objects)}
    manifest_ciphertext = encrypt(
        data=json.dumps(manifest, sort_keys=True).encode(), recipient=recipient
    )
    put_object(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        key=_manifest_key(tenant),
        data=manifest_ciphertext,
    )

    return BackupReport(tenant=tenant, objects=manifest_objects)


@dataclasses.dataclass
class RestoreReport:
    tenant: str
    verified_keys: list[str]
    bytes_recovered: int


def restore_tenant_media(
    *,
    tenant: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    backup_access_key: str,
    backup_secret_key: str,
    identity_path: str,
    target_bucket: str | None = None,
    target_access_key: str | None = None,
    target_secret_key: str | None = None,
    get_object=_default_get_object,
    put_object=_default_put_object,
    decrypt=decrypt_with_age,
) -> RestoreReport:
    """Decrypts every object the tenant's manifest names and checksum-compares
    it against the digest recorded at backup time. Raises
    `MediaRestoreVerificationError` -- never returns a partial report -- on
    the first object that is missing from the backup bucket, that decrypts
    to different bytes than the manifest recorded, or that the given
    identity cannot decrypt at all. When `target_bucket` is given, verified
    plaintext is written there too -- the actual recovery, not only the
    proof of it."""
    try:
        manifest_ciphertext = get_object(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            key=_manifest_key(tenant),
        )
    except ObjectStorageError as error:
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: no manifest at {_manifest_key(tenant)!r} in "
            f"{backup_bucket!r} -- nothing to restore, or the backup never ran: {error}"
        ) from error

    manifest = json.loads(decrypt(data=manifest_ciphertext, identity_path=identity_path))
    if manifest.get("tenant") != tenant:
        raise MediaRestoreVerificationError(
            f"manifest at {_manifest_key(tenant)!r} names tenant "
            f"{manifest.get('tenant')!r}, expected {tenant!r} -- refusing a cross-tenant restore"
        )

    verified: list[str] = []
    bytes_recovered = 0
    for key, expected in sorted(manifest["objects"].items()):
        backup_key = _object_key_for_backup(tenant, key)
        try:
            ciphertext = get_object(
                bucket=backup_bucket,
                endpoint=endpoint,
                region=region,
                access_key=backup_access_key,
                secret_key=backup_secret_key,
                key=backup_key,
            )
        except ObjectStorageError as error:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: backup object {backup_key!r} listed in the manifest "
                f"is missing from {backup_bucket!r}: {error}"
            ) from error

        plaintext = decrypt(data=ciphertext, identity_path=identity_path)
        digest = sha256_hex(plaintext)
        if digest != expected["sha256"]:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: object {key!r} restored to a different digest than "
                f"backup recorded ({digest} != {expected['sha256']}) -- the bytes did not "
                f"come back; this is not a restore"
            )

        if target_bucket is not None:
            put_object(
                bucket=target_bucket,
                endpoint=endpoint,
                region=region,
                access_key=target_access_key,
                secret_key=target_secret_key,
                key=key,
                data=plaintext,
            )

        verified.append(key)
        bytes_recovered += len(plaintext)

    return RestoreReport(tenant=tenant, verified_keys=verified, bytes_recovered=bytes_recovered)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise MediaBackupError(f"{name} must be set in the environment")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    backup_p = sub.add_parser("backup", help="pull, encrypt and store one tenant's live media")
    backup_p.add_argument("--tenant", required=True)
    backup_p.add_argument("--live-bucket", required=True)
    backup_p.add_argument("--backup-bucket", required=True)
    backup_p.add_argument("--endpoint", required=True)
    backup_p.add_argument("--region", required=True)
    backup_p.add_argument(
        "--assert-media-present",
        action="store_true",
        help="refuse a zero-object backup for a tenant known to have live media",
    )

    restore_p = sub.add_parser("restore", help="decrypt and checksum-verify one tenant's media")
    restore_p.add_argument("--tenant", required=True)
    restore_p.add_argument("--backup-bucket", required=True)
    restore_p.add_argument("--target-bucket", help="also write verified plaintext here")
    restore_p.add_argument("--endpoint", required=True)
    restore_p.add_argument("--region", required=True)
    restore_p.add_argument("--identity-file", required=True)

    args = parser.parse_args(argv)

    try:
        if args.command == "backup":
            report = backup_tenant_media(
                tenant=args.tenant,
                live_bucket=args.live_bucket,
                backup_bucket=args.backup_bucket,
                endpoint=args.endpoint,
                region=args.region,
                live_access_key=_require_env("MEDIA_LIVE_ACCESS_KEY_ID"),
                live_secret_key=_require_env("MEDIA_LIVE_SECRET_ACCESS_KEY"),
                backup_access_key=_require_env("MEDIA_BACKUP_ACCESS_KEY_ID"),
                backup_secret_key=_require_env("MEDIA_BACKUP_SECRET_ACCESS_KEY"),
                recipient=_require_env("AGE_RECIPIENT_PUBLIC_KEY"),
                assert_media_present=args.assert_media_present,
            )
            print(
                f"backup: tenant={report.tenant} objects={report.object_count}",
                file=sys.stderr,
            )
        else:
            report = restore_tenant_media(
                tenant=args.tenant,
                backup_bucket=args.backup_bucket,
                target_bucket=args.target_bucket,
                endpoint=args.endpoint,
                region=args.region,
                backup_access_key=_require_env("MEDIA_BACKUP_ACCESS_KEY_ID"),
                backup_secret_key=_require_env("MEDIA_BACKUP_SECRET_ACCESS_KEY"),
                target_access_key=os.environ.get("MEDIA_LIVE_ACCESS_KEY_ID"),
                target_secret_key=os.environ.get("MEDIA_LIVE_SECRET_ACCESS_KEY"),
                identity_path=args.identity_file,
            )
            print(
                f"restore: tenant={report.tenant} verified={len(report.verified_keys)} "
                f"bytes_recovered={report.bytes_recovered}",
                file=sys.stderr,
            )
    except (MediaBackupError, MediaRestoreVerificationError, ObjectStorageError) as error:
        print(f"media_backup_restore: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

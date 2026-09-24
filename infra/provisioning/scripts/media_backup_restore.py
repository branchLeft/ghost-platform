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
manifest that names them. `backup_tenant_media` does not trust its own
`encrypt` call to have honoured that: it re-opens every ciphertext's header
and counts the recipient stanzas, and refuses to write anything with a count
other than one. Destroying that tenant's identity then makes every object
this module wrote unreadable and leaves every other tenant's objects
untouched -- `restore_tenant_media` never falls back to a different key, and
a caller that hands it the wrong tenant's identity gets `age`'s own refusal
("no identity matched any of the recipients"), not a wrong answer.

Fails closed per tenant, never per run: one tenant's missing object, corrupt
ciphertext or empty live bucket raises for that tenant alone and never
touches another tenant's backup or restore.

Layout in the backup bucket, under a `media/<tenant>/` prefix so a tenant's
media backup can never collide with another tenant's or with the database
dumps sharing the same bucket:
  media/<tenant>/objects/<random 64-hex-character id>.age  -- ciphertext, one per object
  media/<tenant>/manifest.json.age                         -- {tenant, objects: {live key: {sha256, size, content_type, backup_id}}, deliberately_empty}

Object keys are RANDOM, never the live key and never derived from the
plaintext -- both were tried and both leak. The live key is the tenant's own
filename; the plaintext's own SHA-256 is a content fingerprint that survives
the tenant's key being destroyed just as easily, because it is computed
before encryption and needs no key at all to recompute -- anyone who already
knows (or can guess) a piece of content can check a tenant's backup listing
for its hash forever, which is pseudonymisation, not erasure. A per-tenant
HMAC does not fix this either: verifying it needs the HMAC key, and unless
that key is destroyed in lockstep with the tenant's `age` identity it
outlives the erasure the whole scheme exists to provide, which defeats the
point more quietly than the plaintext digest did. So the backup id carries no
relationship to the object's content or its live key at all -- see
`generate_backup_object_id` -- and the live-key-to-id mapping, alongside the
plaintext digest restore verification still uses, lives only inside the
encrypted manifest. Content-addressing by a random id also means the
manifest key can never collide with an object key: every object lives under
`objects/`, literally the string `objects/<64 lowercase hex characters>.age`,
and the manifest never does, whatever a tenant happens to have uploaded a
file named -- including a file literally named `manifest.json`.

The empty-backup floor is on by default, the same way `dump_tenant.py`'s
row-count floor is not opt-in: a backup that lists zero live objects raises
unless the caller passes `confirm_tenant_has_no_media=True`, an explicit,
one-shot assertion from whatever already knows this tenant genuinely has no
media (never inferred from an empty listing on its own, which is exactly the
signal a misconfigured live-bucket pointer or a broken listing call would
also produce). A confirmed-empty backup is marked as such in the manifest
(`deliberately_empty: true`), and only that mark lets `restore_tenant_media`
treat zero verified objects as success -- an unmarked manifest with no
objects in it is refused the same way a missing or corrupt object is,
because it is the same failure shape 09-backup-and-recovery.html's R4 names:
a technically-valid, encrypted, empty result that looks exactly like a
healthy backup until someone needs to restore from it.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import pathlib
import re
import secrets
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shared_objectstorage import (  # noqa: E402
    ObjectStorageError,
    get_object as _default_get_object,
    get_object_with_content_type as _default_get_object_with_content_type,
    list_objects as _default_list_objects,
    put_object as _default_put_object,
)

MEDIA_PREFIX = "media"
OBJECTS_PREFIX = "objects"

# Shape-checked, not content-checked: a backup id is 64 lowercase hex
# characters, the same shape `secrets.token_hex(32)` produces and, not
# coincidentally, the same shape a SHA-256 hex digest has -- the pattern
# cannot and does not distinguish "random" from "content-derived" by
# inspection, which is exactly why `generate_backup_object_id` is the one
# function trusted to produce this value rather than any call site being
# allowed to pass a digest directly.
_OPAQUE_ID_HEX = re.compile(r"\A[0-9a-f]{64}\Z")

# One line per `age` recipient stanza, e.g. "-> X25519 <base64>" or the
# scrypt form "-> scrypt <base64> <n>". The `age` binary format spells this
# out in its own spec: every stanza before the body's "---" MAC line starts
# with "-> ", and there is exactly one per recipient the file was encrypted
# to. This is the ONLY thing this pattern is trusted for -- counting
# stanzas, never parsing or trusting their contents.
_AGE_STANZA_LINE = re.compile(rb"\A-> ")
_AGE_HEADER_END = b"---"


class MediaBackupError(Exception):
    """A stage of the media backup did not complete."""


class MediaBackupFloorError(MediaBackupError):
    """The tenant is known to have live media, and the backup captured none
    -- or no one asserted either way, which this pipeline treats the same
    since the default is to assume media is expected.

    Distinguished from `MediaBackupError` so a caller (and a test) can tell
    "something failed" apart from "this specific, self-asserted floor was
    not met" -- the failure shape R4 exists to prevent for media specifically.
    """


class MediaBackupRecipientError(MediaBackupError):
    """A ciphertext this pipeline just produced does not carry exactly one
    `age` recipient stanza. Never a decision to route around: the whole
    crypto-shredding property this module exists to preserve dies with a
    second recipient, silently, while every other signal stays green -- so a
    count other than one aborts the backup for this tenant before anything
    with the extra recipient is written anywhere."""


class MediaRestoreVerificationError(Exception):
    """A restored object's bytes could not be shown to match the backup --
    missing, corrupt, undecryptable with the identity given, or a manifest
    recording zero objects without the deliberate-empty mark. Never
    swallowed: raised on the FIRST such object, because a restore that
    reports partial success is a restore that reports success, and R4 is
    the reason that is not good enough for media either."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate_backup_object_id(*, digest: str) -> str:
    """A random id for one object's backup-bucket key, unrelated to its
    content or its live key -- see the module docstring's "Object keys are
    RANDOM" section for why a content-derived or per-tenant-HMAC-derived id
    both leak. `digest` (the object's plaintext SHA-256) is accepted and
    IGNORED: the parameter exists so a caller -- in practice, only this
    module's own tests -- can inject a deliberately content-derived
    replacement and demonstrate exactly what this function refuses to do,
    not because the real implementation needs to see it.
    `secrets.token_hex`, not `random` or a hash of anything: this value
    never has to be reproduced from anything else, only generated once and
    carried in the manifest, so there is no argument for it being anything
    but unpredictable."""
    del digest
    return secrets.token_hex(32)


def _object_key_for_backup(tenant: str, backup_id: str) -> str:
    """The backup bucket's key for one object, addressed by its random
    `backup_id` (see `generate_backup_object_id`) rather than by the live
    key or the plaintext digest. The format check is defence in depth
    against a corrupt or forged manifest steering a restore at an
    unintended key, not a trust boundary on external input."""
    if not _OPAQUE_ID_HEX.match(backup_id):
        raise MediaBackupError(f"not a valid backup object id: {backup_id!r}")
    return f"{MEDIA_PREFIX}/{tenant}/{OBJECTS_PREFIX}/{backup_id}.age"


def _manifest_key(tenant: str) -> str:
    # Deliberately outside `objects/` -- see the module docstring. No value
    # `_object_key_for_backup` can ever produce collides with this, because
    # every one of those keys starts with `media/<tenant>/objects/` and this
    # one does not.
    return f"{MEDIA_PREFIX}/{tenant}/manifest.json.age"


def _assert_safe_live_key(key: str) -> None:
    """Refuses a live key read out of a DECRYPTED manifest before it is used
    to build a target-bucket write path. A manifest is decrypted, not
    thereby trusted -- see branchLeft/workspace#1346 on forged manifests --
    so a `../` segment or a leading `/` that would write outside the
    restore's intended location is refused here, on the way out, the same
    way backup once refused it on the way in before object keys stopped
    being derived from the live key at all."""
    if key.startswith("/") or ".." in key.split("/"):
        raise MediaRestoreVerificationError(f"refusing an unsafe live key from the manifest: {key!r}")


def count_age_recipient_stanzas(ciphertext: bytes) -> int:
    """How many recipients an `age` ciphertext's header names, read
    structurally rather than trusted from whatever call produced it.

    The age format (https://age-encryption.org/v1) is textual up to the
    header's closing `---` MAC line: one `-> ...` line opens each recipient
    stanza, immediately followed by that stanza's base64 body line(s), and
    the whole file besides is opaque symmetrically-encrypted payload this
    function never touches. Counting `-> ` line prefixes up to the first
    `---` line is therefore an exact count of recipients, not a guess -- and
    it is checked against real `age` output on both a one-recipient and a
    two-recipient ciphertext in this module's own tests, so the count is
    known to agree with what `age` itself considers a recipient rather than
    with an invented reading of the format."""
    count = 0
    for line in ciphertext.split(b"\n"):
        if line == _AGE_HEADER_END:
            break
        if _AGE_STANZA_LINE.match(line):
            count += 1
    return count


def encrypt_with_age(*, data: bytes, recipient: str, run=subprocess.run) -> bytes:
    """Encrypts `data` to exactly one recipient. There is no parameter shape
    here that could carry a second one -- `recipient` is a single string,
    and the argv below has exactly one `-r`. `backup_tenant_media` does not
    stop at trusting that, though: it re-parses every ciphertext this
    function returns and refuses to proceed if the header disagrees."""
    argv = ["age", "-r", recipient]
    result = run(argv, input=data, capture_output=True, check=False)
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


def _encrypt_to_exactly_one_recipient(
    *, data: bytes, recipient: str, encrypt, what: str
) -> bytes:
    """Calls `encrypt`, then checks its own output rather than trusting the
    call -- see `MediaBackupRecipientError`. `what` names the object in the
    error, since this runs once per live object plus once for the manifest
    and a caller needs to know which one."""
    ciphertext = encrypt(data=data, recipient=recipient)
    stanzas = count_age_recipient_stanzas(ciphertext)
    if stanzas != 1:
        raise MediaBackupRecipientError(
            f"{what}: encrypted output carries {stanzas} age recipient stanza(s), expected "
            f"exactly 1 -- refusing to write it. A second recipient here is the exact defect "
            f"09-backup-and-recovery.html names: it would leave this tenant's media backup "
            f"readable after their key is destroyed, with every other signal still green."
        )
    return ciphertext


@dataclasses.dataclass
class BackupReport:
    tenant: str
    objects: dict[str, dict]
    deliberately_empty: bool

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
    confirm_tenant_has_no_media: bool = False,
    list_objects=_default_list_objects,
    get_object_with_content_type=_default_get_object_with_content_type,
    put_object=_default_put_object,
    encrypt=encrypt_with_age,
    generate_backup_id=generate_backup_object_id,
) -> BackupReport:
    """Pulls every object in `live_bucket`, encrypts each to `recipient`, and
    writes the ciphertext plus an encrypted manifest to `backup_bucket`.

    Refuses -- raising `MediaBackupFloorError` and writing nothing -- if the
    live bucket lists zero objects, UNLESS `confirm_tenant_has_no_media` is
    explicitly `True`. That flag is not a convenience default: passing it is
    how a caller who genuinely knows this tenant has no media (a brand-new
    promotion, checked against the promotion record, never inferred from the
    listing being empty) says so, and only that assertion is allowed to write
    a manifest recording zero objects -- which is also the only kind of
    empty manifest `restore_tenant_media` will accept as a real restore
    rather than refuse outright."""
    live_objects = list_objects(
        bucket=live_bucket,
        endpoint=endpoint,
        region=region,
        access_key=live_access_key,
        secret_key=live_secret_key,
    )

    if not live_objects and not confirm_tenant_has_no_media:
        raise MediaBackupFloorError(
            f"tenant {tenant!r}: {live_bucket!r} listed zero objects. Refusing to write an "
            f"empty manifest -- that would look identical to a healthy backup of a tenant "
            f"with nothing uploaded. Pass confirm_tenant_has_no_media=True only if this "
            f"tenant is genuinely known to have no media, from something other than this "
            f"listing being empty."
        )

    manifest_objects: dict[str, dict] = {}
    for entry in live_objects:
        key = entry["key"]
        data, content_type = get_object_with_content_type(
            bucket=live_bucket,
            endpoint=endpoint,
            region=region,
            access_key=live_access_key,
            secret_key=live_secret_key,
            key=key,
        )
        digest = sha256_hex(data)
        backup_id = generate_backup_id(digest=digest)
        ciphertext = _encrypt_to_exactly_one_recipient(
            data=data, recipient=recipient, encrypt=encrypt, what=f"object {key!r}"
        )
        put_object(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            key=_object_key_for_backup(tenant, backup_id),
            data=ciphertext,
        )
        manifest_objects[key] = {
            "sha256": digest,
            "size": len(data),
            "content_type": content_type,
            "backup_id": backup_id,
        }

    deliberately_empty = not manifest_objects
    manifest = {
        "tenant": tenant,
        "objects": manifest_objects,
        "object_count": len(manifest_objects),
        "deliberately_empty": deliberately_empty,
    }
    manifest_ciphertext = _encrypt_to_exactly_one_recipient(
        data=json.dumps(manifest, sort_keys=True).encode(),
        recipient=recipient,
        encrypt=encrypt,
        what="the manifest",
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

    return BackupReport(tenant=tenant, objects=manifest_objects, deliberately_empty=deliberately_empty)


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
    `MediaRestoreVerificationError` and returns nothing -- the RETURN VALUE
    is never partial -- on the first object that is missing from the backup
    bucket, that decrypts to different bytes than the manifest recorded, or
    that the given identity cannot decrypt at all; also raises if the
    manifest names zero objects without `deliberately_empty: true`, the same
    R4 shape as a missing or corrupt object. When `target_bucket` is given,
    each object already verified before a later failure has ALREADY been
    written there -- a partial restore on disk is real and intended (the
    objects that did verify are genuinely recovered), only the return value
    and exit code are all-or-nothing. Each object's backup-bucket key comes
    from `backup_id` in the manifest, never derived from the live key here;
    the live key itself is only ever used as the write path into
    `target_bucket`, and is checked by `_assert_safe_live_key` immediately
    before that write -- a decrypted manifest is not thereby a trusted one."""
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

    manifest_objects = manifest.get("objects") or {}
    if not manifest_objects and not manifest.get("deliberately_empty"):
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: manifest at {_manifest_key(tenant)!r} names zero objects and "
            f"is not marked deliberately_empty -- a valid, encrypted, empty manifest is not "
            f"evidence of a successful restore (09-backup-and-recovery.html's R4), so this is "
            f"refused the same way a missing or corrupt object would be"
        )

    verified: list[str] = []
    bytes_recovered = 0
    for key, expected in sorted(manifest_objects.items()):
        backup_key = _object_key_for_backup(tenant, expected["backup_id"])
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
                f"for live key {key!r} is missing from {backup_bucket!r}: {error}"
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
            _assert_safe_live_key(key)
            put_object(
                bucket=target_bucket,
                endpoint=endpoint,
                region=region,
                access_key=target_access_key,
                secret_key=target_secret_key,
                key=key,
                data=plaintext,
                content_type=expected.get("content_type") or "application/octet-stream",
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
        "--confirm-tenant-has-no-media",
        action="store_true",
        help=(
            "required to back up a tenant whose live bucket lists zero objects -- refused "
            "by default. Pass this only when the tenant is genuinely known to have no media, "
            "never merely because the listing came back empty."
        ),
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
                confirm_tenant_has_no_media=args.confirm_tenant_has_no_media,
            )
            print(
                f"backup: tenant={report.tenant} objects={report.object_count} "
                f"deliberately_empty={report.deliberately_empty}",
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

#!/usr/bin/env python3
"""Back up one tenant's live media to the backup bucket, and restore it
back -- proving the *bytes*, not that the objects merely exist.

Backup is put-only against the backup bucket: each run writes a new dated
generation and never lists, reads or deletes there, so the put-only key is
enough and old generations are aged out by the bucket's lifecycle rule.
Restore verifies the bytes. See media_backup_restore.md#module-overview.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
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
GENERATIONS_PREFIX = "generations"
OBJECTS_PREFIX = "objects"

# Shape-checked, not content-checked: a backup id is 64 lowercase hex
# characters, the same shape `secrets.token_hex(32)` produces and, not
# coincidentally, the same shape a SHA-256 hex digest has -- the pattern
# cannot and does not distinguish "random" from "content-derived" by
# inspection, which is exactly why `generate_backup_object_id` is the one
# function trusted to produce this value rather than any call site being
# allowed to pass a digest directly.
_OPAQUE_ID_HEX = re.compile(r"\A[0-9a-f]{64}\Z")

# A run id: an UTC timestamp (date, time, six-digit microseconds, all fixed
# width) followed by 16 random hex characters. Fixed width end to end means
# lexicographic order IS chronological order for the timestamp portion, so
# "newest generation" and "oldest generation" are always a plain string
# min/max over whatever a listing returns -- no parsing needed to compare
# two run ids. The random suffix exists only to guarantee two runs starting
# within the same microsecond still sort distinctly and deterministically
# from each other; which of the two sorts first in that case is arbitrary
# and does not need to mean anything.
_RUN_ID_RE = re.compile(r"\A[0-9]{8}T[0-9]{12}Z-[0-9a-f]{16}\Z")

# A tenant slug: lowercase letters, digits and hyphens only, 1-63
# characters, no leading or trailing hyphen -- the same shape a DNS label
# allows. Checked at the boundary of both public functions before `tenant`
# is used to build a single backup-bucket key: neither `/` nor `..` is in
# this character set, so a tenant string can never widen a key past its own
# `media/<tenant>/generations/` prefix, and no tenant's name can ever be a
# string-prefix of another's (`generations/` immediately follows it).
_TENANT_SLUG_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")

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


def generate_run_id() -> str:
    """A fresh, sortable id for one backup run -- see the module-level
    `_RUN_ID_RE` comment for the shape and why it sorts chronologically.
    `secrets.token_hex`, not a counter or anything read from storage: this
    value has to be unique and comparable across concurrent, uncoordinated
    processes that share no state and take no lock, not merely unique within
    one process."""
    now = datetime.datetime.now(datetime.timezone.utc)
    return f"{now:%Y%m%dT%H%M%S}{now.microsecond:06d}Z-{secrets.token_hex(8)}"


def generate_backup_object_id(*, digest: str) -> str:
    """A random, content-unrelated id for one object's backup-bucket key.
    `digest` is accepted and IGNORED -- only this module's own tests use it.
    See media_backup_restore.md#generate_backup_object_id."""
    del digest
    return secrets.token_hex(32)


def _assert_valid_tenant_slug(tenant: str, error_cls: type[Exception]) -> None:
    """Refuses a tenant string before it is used to build a single
    backup-bucket key -- see the module-level `_TENANT_SLUG_RE` comment.
    `error_cls` lets each public function raise its own exception type
    (`MediaBackupError` from `backup_tenant_media`,
    `MediaRestoreVerificationError` from `restore_tenant_media`) for the
    same shape of refusal."""
    if not _TENANT_SLUG_RE.match(tenant):
        raise error_cls(
            f"tenant {tenant!r} is not a valid slug -- lowercase letters, digits and "
            f"hyphens only, 1-63 characters, no leading or trailing hyphen. Refusing "
            f"before it is used to build any backup-bucket key."
        )


def _tenant_generations_prefix(tenant: str) -> str:
    return f"{MEDIA_PREFIX}/{tenant}/{GENERATIONS_PREFIX}/"


def _generation_prefix(tenant: str, run_id: str) -> str:
    if not _RUN_ID_RE.match(run_id):
        raise MediaBackupError(f"not a valid run id: {run_id!r}")
    return f"{_tenant_generations_prefix(tenant)}{run_id}/"


def _object_key_for_backup(tenant: str, run_id: str, backup_id: str) -> str:
    """The backup bucket's key for one object, addressed by its random
    `backup_id` (see `generate_backup_object_id`) under its run's own
    generation prefix -- never by the live key or the plaintext digest. The
    format checks here are defence in depth against a corrupt or forged
    manifest steering a restore at an unintended key, not a trust boundary
    on external input."""
    if not _OPAQUE_ID_HEX.match(backup_id):
        raise MediaBackupError(f"not a valid backup object id: {backup_id!r}")
    return f"{_generation_prefix(tenant, run_id)}{OBJECTS_PREFIX}/{backup_id}.age"


def _manifest_key(tenant: str, run_id: str) -> str:
    # Deliberately outside `objects/` -- see the module docstring. No value
    # `_object_key_for_backup` can ever produce collides with this, because
    # every one of those keys starts with this generation's `objects/` and
    # this one does not.
    return f"{_generation_prefix(tenant, run_id)}manifest.json.age"


def _generation_key_pattern(tenant: str) -> re.Pattern[str]:
    """The exact key shape this module ever writes for `tenant`, and
    nothing else -- used to validate every key a listing returns before it
    is trusted. `tenant` is
    re.escape'd even though `_assert_valid_tenant_slug` already restricts
    its character set to one with no regex metacharacters, because this
    function must stay correct even if that restriction is ever loosened."""
    escaped = re.escape(tenant)
    return re.compile(
        rf"\A{MEDIA_PREFIX}/{escaped}/{GENERATIONS_PREFIX}/"
        rf"(?P<run_id>[0-9]{{8}}T[0-9]{{12}}Z-[0-9a-f]{{16}})/"
        rf"(?:{OBJECTS_PREFIX}/(?P<backup_id>[0-9a-f]{{64}})\.age\Z|manifest\.json\.age\Z)"
    )


def _list_tenant_manifests(
    *,
    tenant: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    list_objects,
) -> dict[str, str]:
    """Every `{run_id: manifest_key}` pair under this tenant's
    `generations/` prefix that actually has a manifest present in the
    listing. The manifest is the completion marker, written last, so a
    generation without one is incomplete (an aborted or still-uploading
    run) and is never a restore candidate, whether asked for by name or
    found as the newest. Every key considered
    is checked against this tenant's exact key shape first; anything else
    in the listing is ignored here, since restore never deletes anything."""
    pattern = _generation_key_pattern(tenant)
    entries = list_objects(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        prefix=_tenant_generations_prefix(tenant),
    )
    manifests: dict[str, str] = {}
    for entry in entries:
        key = entry["key"]
        if not key.endswith("manifest.json.age"):
            continue
        match = pattern.match(key)
        if match:
            manifests[match.group("run_id")] = key
    return manifests


def find_newest_generation(
    *,
    tenant: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    list_objects,
) -> tuple[str, str] | None:
    """Returns `(run_id, manifest_key)` for the lexicographically greatest
    run id that has a manifest present -- see `_list_tenant_manifests`.
    Returns `None` if no generation has one."""
    manifests = _list_tenant_manifests(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        list_objects=list_objects,
    )
    if not manifests:
        return None
    newest_run_id = max(manifests)
    return newest_run_id, manifests[newest_run_id]


def _assert_safe_live_key(key: str) -> None:
    """Refuses a live key read out of a DECRYPTED manifest before it is used
    to build a target-bucket write path. A manifest is decrypted, not
    thereby trusted: nothing in `age`'s format authenticates who wrote a
    ciphertext, only that it decrypts under the given identity, so a `../`
    segment or a leading `/` that would write outside the restore's
    intended location is refused here, on the way out, the same way backup
    once refused it on the way in before object keys stopped being derived
    from the live key at all."""
    if key.startswith("/") or ".." in key.split("/"):
        raise MediaRestoreVerificationError(f"refusing an unsafe live key from the manifest: {key!r}")


def count_age_recipient_stanzas(ciphertext: bytes) -> int:
    """How many recipients an `age` ciphertext's header names, read
    structurally (counting `-> ` stanza lines up to the header's `---` MAC
    line) rather than trusted from whatever call produced it.
    See media_backup_restore.md#count_age_recipient_stanzas."""
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
    run_id: str
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
    make_run_id=generate_run_id,
) -> BackupReport:
    """Pulls every object in `live_bucket`, encrypts each to `recipient`,
    and writes the ciphertext to `backup_bucket` under a fresh dated
    generation, then writes that generation's manifest last as its
    completion marker. The only calls made against `backup_bucket` are
    PUTs: the backup key is put-only, so nothing here lists, reads back or
    deletes there, and old generations leave by the bucket's lifecycle rule.
    Refuses an empty live bucket unless `confirm_tenant_has_no_media=True`.
    May raise `MediaBackupFloorError`. See media_backup_restore.md#backup_tenant_media."""
    _assert_valid_tenant_slug(tenant, MediaBackupError)

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

    run_id = make_run_id()

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
            key=_object_key_for_backup(tenant, run_id, backup_id),
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
        "run_id": run_id,
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

    # The completion marker, and the last write of the run. A generation with
    # no manifest is incomplete by definition and restore never reads it.
    put_object(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        key=_manifest_key(tenant, run_id),
        data=manifest_ciphertext,
    )

    return BackupReport(
        tenant=tenant,
        run_id=run_id,
        objects=manifest_objects,
        deliberately_empty=deliberately_empty,
    )


@dataclasses.dataclass
class RestoreReport:
    tenant: str
    run_id: str
    verified_keys: list[str]
    bytes_recovered: int


def _restore_generation(
    *,
    tenant: str,
    run_id: str,
    manifest_key: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    backup_access_key: str,
    backup_secret_key: str,
    identity_path: str,
    target_bucket: str | None,
    target_access_key: str | None,
    target_secret_key: str | None,
    get_object,
    put_object,
    decrypt,
) -> RestoreReport:
    """Decrypts and checksum-verifies every object that ONE named
    generation's manifest lists. Never falls back and never tries another
    generation -- `restore_tenant_media` is the only thing that decides
    which generation this runs against, and calls this at most once per
    generation per restore, per the "never silently fall back to older
    data" contract."""
    try:
        manifest_ciphertext = get_object(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            key=manifest_key,
        )
    except ObjectStorageError as error:
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: the manifest listed at {manifest_key!r} could not be read "
            f"from {backup_bucket!r}: {error}"
        ) from error

    manifest_plaintext = decrypt(data=manifest_ciphertext, identity_path=identity_path)
    try:
        manifest = json.loads(manifest_plaintext)
    except json.JSONDecodeError as error:
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: the manifest at {manifest_key!r} decrypted, but is not valid "
            f"JSON -- exactly the shape a manifest PUT that reported success but did not "
            f"durably store what was sent would leave behind: a manifest key that exists, but "
            f"is not the bytes this run actually wrote ({error})"
        ) from error

    if not isinstance(manifest, dict):
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: the manifest at {manifest_key!r} decrypted and is valid "
            f"JSON, but is not a JSON object ({type(manifest).__name__}) -- refusing to "
            f"treat it as a manifest"
        )

    if manifest.get("tenant") != tenant:
        raise MediaRestoreVerificationError(
            f"manifest at {manifest_key!r} names tenant {manifest.get('tenant')!r}, expected "
            f"{tenant!r} -- refusing a cross-tenant restore"
        )

    manifest_objects = manifest.get("objects") or {}
    if not isinstance(manifest_objects, dict):
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: manifest at {manifest_key!r} has an 'objects' entry that "
            f"is not a JSON object ({type(manifest_objects).__name__}) -- refusing to treat "
            f"it as a per-live-key mapping"
        )
    if not manifest_objects and not manifest.get("deliberately_empty"):
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: manifest at {manifest_key!r} names zero objects and is not "
            f"marked deliberately_empty -- a valid, encrypted, empty manifest is not "
            f"evidence of a successful restore (09-backup-and-recovery.html's R4), so this is "
            f"refused the same way a missing or corrupt object would be"
        )

    verified: list[str] = []
    bytes_recovered = 0
    for key, expected in sorted(manifest_objects.items()):
        try:
            backup_id = expected["backup_id"]
        except (KeyError, TypeError) as error:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: the manifest entry for live key {key!r} has no usable "
                f"'backup_id' -- cannot locate its backup object"
            ) from error
        try:
            backup_key = _object_key_for_backup(tenant, run_id, backup_id)
        except (MediaBackupError, TypeError) as error:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: the manifest entry for live key {key!r} has a malformed "
                f"'backup_id' ({backup_id!r}): {error}"
            ) from error
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

        try:
            expected_sha256 = expected["sha256"]
        except (KeyError, TypeError) as error:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: the manifest entry for live key {key!r} has no usable "
                f"'sha256' -- cannot verify the restored bytes"
            ) from error

        plaintext = decrypt(data=ciphertext, identity_path=identity_path)
        digest = sha256_hex(plaintext)
        if digest != expected_sha256:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: object {key!r} restored to a different digest than "
                f"backup recorded ({digest} != {expected_sha256}) -- the bytes did not "
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

    return RestoreReport(tenant=tenant, run_id=run_id, verified_keys=verified, bytes_recovered=bytes_recovered)


def restore_tenant_media(
    *,
    tenant: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    backup_access_key: str,
    backup_secret_key: str,
    identity_path: str,
    run_id: str | None = None,
    target_bucket: str | None = None,
    target_access_key: str | None = None,
    target_secret_key: str | None = None,
    list_objects=_default_list_objects,
    get_object=_default_get_object,
    put_object=_default_put_object,
    decrypt=decrypt_with_age,
) -> RestoreReport:
    """Restores this tenant's NEWEST generation by default, or a specific
    `run_id` -- never silently falling back to an older one if the newest
    fails verification. Raises `MediaRestoreVerificationError` on the first
    missing, mismatched or undecryptable object, naming the recovery
    command for the newest older generation. See
    media_backup_restore.md#restore_tenant_media."""
    _assert_valid_tenant_slug(tenant, MediaRestoreVerificationError)

    manifests = _list_tenant_manifests(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        list_objects=list_objects,
    )
    if not manifests:
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: no generation with a manifest under "
            f"{_tenant_generations_prefix(tenant)!r} in {backup_bucket!r} -- nothing to "
            f"restore, or the backup never ran"
        )

    restore_kwargs = dict(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        backup_access_key=backup_access_key,
        backup_secret_key=backup_secret_key,
        identity_path=identity_path,
        target_bucket=target_bucket,
        target_access_key=target_access_key,
        target_secret_key=target_secret_key,
        get_object=get_object,
        put_object=put_object,
        decrypt=decrypt,
    )

    if run_id is not None:
        if not _RUN_ID_RE.match(run_id):
            raise MediaRestoreVerificationError(f"not a valid run id: {run_id!r}")
        if run_id not in manifests:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: no manifest at generation {run_id!r}. Generations with a "
                f"manifest, newest first: {', '.join(sorted(manifests, reverse=True))}"
            )
        # Named explicitly -- exactly what the caller asked for, never
        # silently redirected to a different generation on failure.
        return _restore_generation(run_id=run_id, manifest_key=manifests[run_id], **restore_kwargs)

    newest_run_id = max(manifests)
    try:
        return _restore_generation(
            run_id=newest_run_id, manifest_key=manifests[newest_run_id], **restore_kwargs
        )
    except MediaRestoreVerificationError as error:
        older_run_ids = sorted((rid for rid in manifests if rid < newest_run_id), reverse=True)
        if not older_run_ids:
            raise MediaRestoreVerificationError(
                f"tenant {tenant!r}: the newest generation ({newest_run_id!r}) failed "
                f"verification: {error}. No older generation has a manifest either -- "
                f"nothing to fall back to."
            ) from error
        fallback_run_id = older_run_ids[0]
        command = (
            f"python3 media_backup_restore.py restore --tenant {tenant} "
            f"--backup-bucket {backup_bucket} --endpoint {endpoint} --region {region} "
            f"--identity-file {identity_path} --run-id {fallback_run_id}"
        )
        if target_bucket is not None:
            command += f" --target-bucket {target_bucket}"
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: the newest generation ({newest_run_id!r}) failed "
            f"verification: {error}. Never falling back automatically -- the newest OLDER "
            f"generation with a manifest is {fallback_run_id!r}. Restore it explicitly: "
            f"{command}"
        ) from error


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
            "by default. Pass this only when the tenant is genuinely known to have no "
            "media, never merely because the listing came back empty."
        ),
    )

    restore_p = sub.add_parser("restore", help="decrypt and checksum-verify one tenant's media")
    restore_p.add_argument("--tenant", required=True)
    restore_p.add_argument("--backup-bucket", required=True)
    restore_p.add_argument("--target-bucket", help="also write verified plaintext here")
    restore_p.add_argument("--endpoint", required=True)
    restore_p.add_argument("--region", required=True)
    restore_p.add_argument("--identity-file", required=True)
    restore_p.add_argument(
        "--run-id",
        help=(
            "restore this specific generation instead of the newest -- never chosen "
            "automatically; use this after a failed default restore names it as the newest "
            "generation with a manifest that still verifies"
        ),
    )

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
                f"backup: tenant={report.tenant} run_id={report.run_id} "
                f"objects={report.object_count} deliberately_empty={report.deliberately_empty}",
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
                run_id=args.run_id,
            )
            print(
                f"restore: tenant={report.tenant} run_id={report.run_id} "
                f"verified={len(report.verified_keys)} bytes_recovered={report.bytes_recovered}",
                file=sys.stderr,
            )
    except (MediaBackupError, MediaRestoreVerificationError, ObjectStorageError) as error:
        print(f"media_backup_restore: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

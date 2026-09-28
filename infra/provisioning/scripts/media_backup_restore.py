#!/usr/bin/env python3
"""Back up one tenant's live media to the backup bucket, and restore it
back -- proving the *bytes*, not that the objects merely exist.

Fails closed per tenant, never per run, and never trusts a `2xx` response
as proof of persistence; generations (never a flat prefix) make two
overlapping runs of the same tenant safe with no lock and no new secret.
See media_backup_restore.md#module-overview.
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
    delete_object as _default_delete_object,
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
# and, by the module docstring's own argument, does not need to mean
# anything -- see "GENERATIONS, THE ORDERING GUARANTEE" above.
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


class MediaBackupConfirmedEmptyConflictError(MediaBackupError):
    """`confirm_tenant_has_no_media=True` was passed, but a previous
    generation for this tenant already holds objects. Distinguished so a
    caller can tell this apart from the ordinary floor: the flag is refused
    here rather than honoured, because honouring it would delete a populated
    generation on the strength of a single flag with no corroborating
    evidence that the tenant's media is genuinely gone rather than merely
    unlisted this run."""


class MediaBackupRecipientError(MediaBackupError):
    """A ciphertext this pipeline just produced does not carry exactly one
    `age` recipient stanza. Never a decision to route around: the whole
    crypto-shredding property this module exists to preserve dies with a
    second recipient, silently, while every other signal stays green -- so a
    count other than one aborts the backup for this tenant before anything
    with the extra recipient is written anywhere."""


class MediaBackupManifestVerificationError(MediaBackupError):
    """The manifest just PUT to the backup bucket did not read back
    byte-identical to what was sent. Distinguished from `MediaBackupError`
    so a caller and a test can tell this specific control apart: this run
    deletes older generations on the strength of this read-back alone, so a
    mismatch here has to stop the run before deletion, not just fail loudly
    after."""


class MediaBackupObjectVerificationError(MediaBackupError):
    """A fresh pre-delete listing is missing an object key this run itself
    wrote -- so its manifest cannot be trusted; nothing is deleted.
    See media_backup_restore.md#mediabackupobjectverificationerror."""


class MediaBackupClockSkewError(MediaBackupError):
    """A later generation's run id sorts after this run's own, so restore
    keeps reading that one instead -- this run's own backup is not lost,
    only not the one read next. See
    media_backup_restore.md#mediabackupclockskewerror."""


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
    is trusted for a presence check or a delete decision. `tenant` is
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
    listing -- a generation with no manifest is an orphan (an aborted or a
    superseded-while-still-uploading run) and is never a restore candidate,
    whether asked for by name or found as the newest. Every key considered
    is checked against this tenant's exact key shape first; anything else
    in the listing is ignored here (restore reads are not the place that
    refuses on an unexpected key -- `backup_tenant_media`'s own checks are,
    since restore never deletes anything)."""
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
    deleted_previous_keys: list[str] = dataclasses.field(default_factory=list)

    @property
    def object_count(self) -> int:
        return len(self.objects)


def _write_and_verify_manifest(
    *,
    tenant: str,
    run_id: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    ciphertext: bytes,
    put_object,
    get_object,
) -> None:
    """PUTs this run's manifest, then reads it straight back and checks it
    matches byte-for-byte before anything else is allowed to trust it
    exists. See the module docstring: a 2xx on the PUT is not by itself
    evidence the write is durable, and `backup_tenant_media` deletes older
    generations only once this function returns without raising."""
    key = _manifest_key(tenant, run_id)
    put_object(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        key=key,
        data=ciphertext,
    )
    readback = get_object(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        key=key,
    )
    if readback != ciphertext:
        raise MediaBackupManifestVerificationError(
            f"tenant {tenant!r}, run {run_id!r}: the manifest just written to {key!r} does "
            f"not read back byte-identical to what was sent -- refusing to delete any older "
            f"generation against a manifest that may not be durably the one this run just wrote"
        )


def _sorts_before(candidate_run_id: str, run_id: str) -> bool:
    """Whether `candidate_run_id` is strictly OLDER than `run_id` -- the one
    predicate this module trusts, everywhere, to decide "safe to delete"
    against any OTHER generation, complete or still uploading. Never a
    same-or-later id, regardless of how much of that other run has landed
    -- see the module docstring's "GENERATIONS, THE ORDERING GUARANTEE"
    section for why that alone is enough to make two overlapping runs safe
    with no lock. A single, shared predicate rather than this comparison
    being repeated at each call site: every place that decides what is
    "older" agrees with every other one, by construction."""
    return candidate_run_id < run_id


def _list_tenant_generation_keys(
    *,
    tenant: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    list_objects,
) -> dict[str, str]:
    """Every key under this tenant's whole `generations/` prefix, mapped to
    the run id it belongs to. Every key is checked against this module's
    own exact key shape first; a listing that returns anything else
    (a bug elsewhere, a forged object, a `prefix` argument silently
    ignored) aborts the caller rather than being folded into a presence
    check or a delete decision it was never meant to answer."""
    prefix = _tenant_generations_prefix(tenant)
    pattern = _generation_key_pattern(tenant)
    entries = list_objects(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        prefix=prefix,
    )
    keys: dict[str, str] = {}
    for entry in entries:
        key = entry["key"]
        match = pattern.match(key)
        if not match:
            raise MediaBackupError(
                f"tenant {tenant!r}: an object under {prefix!r} does not match this "
                f"module's own key shape: {key!r} -- refusing to reason about deletion "
                f"while a listing scoped to this tenant contains a key this module never "
                f"wrote"
            )
        keys[key] = match.group("run_id")
    return keys


def _assert_written_keys_present(
    *,
    tenant: str,
    run_id: str,
    written_this_run: set[str],
    listed_keys,
    when: str,
) -> None:
    """Raises `MediaBackupObjectVerificationError` unless every key in
    `written_this_run` is present in `listed_keys` -- shared by both the
    pre-manifest and the post-manifest presence checks (see
    `backup_tenant_media`), so a 2xx PUT that never actually landed is
    caught the same way regardless of which of the two catches it. `when`
    names which check failed, since the two mean different things: caught
    before the manifest exists at all, or caught after, by an overlapping
    run's cleanup racing this one."""
    missing = written_this_run - set(listed_keys)
    if missing:
        raise MediaBackupObjectVerificationError(
            f"tenant {tenant!r}, run {run_id!r}: {len(missing)} object(s) this run itself "
            f"just wrote are not present in a fresh listing, checked {when} -- a 2xx on the "
            f"PUT is not proof a write landed. Refusing to proceed while this run's own "
            f"objects cannot be found. One missing key: {sorted(missing)[0]!r}"
        )


def _delete_older_generations(
    *,
    tenant: str,
    run_id: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    listed_keys: dict[str, str],
    delete_object,
) -> list[str]:
    """Deletes every key in `listed_keys` whose run id sorts strictly
    before `run_id` (see `_sorts_before`) and returns them, sorted. The
    caller decides what `listed_keys` covers -- the whole tenant prefix for
    an end-of-run supersession, or a narrower orphan sweep."""
    older_keys = sorted(key for key, candidate in listed_keys.items() if _sorts_before(candidate, run_id))
    for key in older_keys:
        delete_object(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            key=key,
        )
    return older_keys


def _best_effort_delete_this_runs_own_uploads(
    *,
    tenant: str,
    run_id: str,
    keys: set[str],
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    delete_object,
) -> None:
    """Best-effort clean-up, run only before this run's own manifest PUT is
    attempted, of the object keys this run itself already wrote -- logged
    and swallowed on failure, never replacing the exception that triggered
    it. See media_backup_restore.md#_best_effort_delete_this_runs_own_uploads."""
    for key in sorted(keys):
        try:
            delete_object(
                bucket=backup_bucket,
                endpoint=endpoint,
                region=region,
                access_key=access_key,
                secret_key=secret_key,
                key=key,
            )
        except Exception as cleanup_error:  # noqa: BLE001 -- best effort, see docstring
            print(
                f"media_backup_restore: tenant {tenant!r}, run {run_id!r}: best-effort "
                f"clean-up of this run's own pre-manifest upload {key!r} failed and is "
                f"being ignored -- {cleanup_error}",
                file=sys.stderr,
            )


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
    get_object=_default_get_object,
    put_object=_default_put_object,
    delete_object=_default_delete_object,
    encrypt=encrypt_with_age,
    generate_backup_id=generate_backup_object_id,
    make_run_id=generate_run_id,
) -> BackupReport:
    """Pulls every object in `live_bucket`, encrypts each to `recipient`,
    and writes the ciphertext to `backup_bucket` under a fresh generation
    prefix, deleting older generations only once presence checks (repeated
    across the manifest write) prove the new one durable. Refuses an empty
    live bucket unless `confirm_tenant_has_no_media=True`, which is itself
    refused if a previous generation already holds objects. May raise
    `MediaBackupFloorError`, `MediaBackupConfirmedEmptyConflictError` or
    `MediaBackupClockSkewError`. See media_backup_restore.md#backup_tenant_media."""
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

    if not live_objects and confirm_tenant_has_no_media:
        pattern = _generation_key_pattern(tenant)
        existing = list_objects(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            prefix=_tenant_generations_prefix(tenant),
        )
        if any(
            pattern.match(entry["key"]) and f"/{OBJECTS_PREFIX}/" in entry["key"]
            for entry in existing
        ):
            raise MediaBackupConfirmedEmptyConflictError(
                f"tenant {tenant!r}: confirm_tenant_has_no_media=True was passed, but a "
                f"previous generation under {_tenant_generations_prefix(tenant)!r} already "
                f"holds objects. Refusing -- this flag is for a brand-new tenant with no "
                f"previous generation at all, never to empty a populated one."
            )

    run_id = make_run_id()

    # Checked now, before uploading anything, so a persistent failure costs
    # one listing per run rather than a full re-upload each time.
    # See media_backup_restore.md#backup_tenant_media-pre-upload-orphan-sweep.
    existing_generation_keys = _list_tenant_generation_keys(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        list_objects=list_objects,
    )
    manifested_run_ids = {
        candidate for key, candidate in existing_generation_keys.items()
        if key.endswith("manifest.json.age")
    }
    # An orphan (no manifest in THIS listing) is only reclaimed here when it
    # sorts before the newest generation this same listing already shows a
    # manifest for -- such an orphan can never become the tenant's newest
    # restorable generation, because a newer, already-complete one exists in
    # the same snapshot. An orphan that does not clear that bar cannot be
    # ruled out this way: this listing is a snapshot, and the run that owns
    # it may write its own manifest moments after the listing was taken,
    # becoming the newest verified generation while this sweep's deletes are
    # still in flight -- so this listing having no manifest at all means
    # nothing here is reclaimed.
    if manifested_run_ids:
        newest_manifested_run_id = max(manifested_run_ids)
        orphaned_keys = {
            key: candidate
            for key, candidate in existing_generation_keys.items()
            if candidate not in manifested_run_ids
            and _sorts_before(candidate, newest_manifested_run_id)
        }
    else:
        orphaned_keys = {}
    reclaimed_orphan_keys = _delete_older_generations(
        tenant=tenant,
        run_id=run_id,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        listed_keys=orphaned_keys,
        delete_object=delete_object,
    )

    new_backup_keys: set[str] = set()
    # Everything from here up to, but never including, the manifest PUT
    # itself (`_write_and_verify_manifest` below) is covered by this run's
    # own best-effort clean-up on failure -- see
    # `_best_effort_delete_this_runs_own_uploads` and the module docstring.
    # With no manifest ever written, this run's own generation has nothing
    # else depending on it, so a failure here deletes its own uploads
    # rather than leaving them as a fresh orphan every time it recurs.
    try:
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
            backup_key = _object_key_for_backup(tenant, run_id, backup_id)
            put_object(
                bucket=backup_bucket,
                endpoint=endpoint,
                region=region,
                access_key=backup_access_key,
                secret_key=backup_secret_key,
                key=backup_key,
                data=ciphertext,
            )
            new_backup_keys.add(backup_key)
            manifest_objects[key] = {
                "sha256": digest,
                "size": len(data),
                "content_type": content_type,
                "backup_id": backup_id,
            }

        # THE ORDERING GUARANTEE, PART 1. A fresh listing, taken right here
        # -- after every upload above and BEFORE this run's manifest is
        # ever written -- must show every object this run itself wrote. A
        # manifest existing is meant to mean "this generation is complete":
        # writing one before this check would let a caught, detected
        # failure still leave behind a manifest that names an object nobody
        # can find. See the module docstring's "THE DELETE STEP IS TRUSTED
        # WITH NOTHING" section.
        pre_manifest_keys = _list_tenant_generation_keys(
            tenant=tenant,
            backup_bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            list_objects=list_objects,
        )
        _assert_written_keys_present(
            tenant=tenant,
            run_id=run_id,
            written_this_run=new_backup_keys,
            listed_keys=pre_manifest_keys,
            when="before the manifest was written",
        )

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
    except Exception:
        _best_effort_delete_this_runs_own_uploads(
            tenant=tenant,
            run_id=run_id,
            keys=new_backup_keys,
            backup_bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=backup_access_key,
            secret_key=backup_secret_key,
            delete_object=delete_object,
        )
        raise

    _write_and_verify_manifest(
        tenant=tenant,
        run_id=run_id,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        ciphertext=manifest_ciphertext,
        put_object=put_object,
        get_object=get_object,
    )

    # THE ORDERING GUARANTEE, PART 2. Repeated after the manifest write,
    # for concurrency: an overlapping run with a LARGER id can delete this
    # run's own objects (fair game -- this run's id sorts before its own)
    # in the gap between PART 1 above and the manifest actually landing.
    # Only once this second check also holds does deletion run -- nothing
    # above this point can have deleted anything.
    post_manifest_keys = _list_tenant_generation_keys(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        list_objects=list_objects,
    )
    _assert_written_keys_present(
        tenant=tenant,
        run_id=run_id,
        written_this_run=new_backup_keys,
        listed_keys=post_manifest_keys,
        when="after the manifest was written",
    )

    deleted_previous_keys = _delete_older_generations(
        tenant=tenant,
        run_id=run_id,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        listed_keys=post_manifest_keys,
        delete_object=delete_object,
    )

    # One last listing, after this run's own delete step, catches a
    # generation whose clock ran ahead of this one's -- see
    # `MediaBackupClockSkewError`. This run's own backup above is already
    # complete and durable regardless of what this check finds; it only
    # ever reports a problem with WHICH generation restore will pick.
    final_manifests = _list_tenant_manifests(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        list_objects=list_objects,
    )
    newer_run_ids = sorted(candidate for candidate in final_manifests if candidate > run_id)
    if newer_run_ids:
        raise MediaBackupClockSkewError(
            f"tenant {tenant!r}: this run's own backup (run {run_id!r}) completed and is "
            f"durable, but a generation with a manifest ({newer_run_ids[-1]!r}) still sorts "
            f"AFTER it, even after this run's own delete step -- restore_tenant_media always "
            f"reads the newest id, so it will keep reading that generation, not this run's, "
            f"until a correctly-dated run supersedes it too. A newer generation exists: "
            f"another run overlapped this one, or this host's clock is behind."
        )

    return BackupReport(
        tenant=tenant,
        run_id=run_id,
        objects=manifest_objects,
        deliberately_empty=deliberately_empty,
        deleted_previous_keys=sorted(set(deleted_previous_keys) | set(reclaimed_orphan_keys)),
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
            "by default, and itself refused if a previous generation already holds objects. "
            "Pass this only when the tenant is genuinely known to have no media, never "
            "merely because the listing came back empty."
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
                f"objects={report.object_count} deliberately_empty={report.deliberately_empty} "
                f"deleted_older_generation_keys={len(report.deleted_previous_keys)}",
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

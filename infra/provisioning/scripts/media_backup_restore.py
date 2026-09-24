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

GENERATIONS, NOT A FLAT TENANT PREFIX. Every run gets its own, disjoint
prefix, named by a sortable run id (a UTC timestamp plus random suffix --
see `generate_run_id`) that never repeats and never has to be reasoned about
across runs:

  media/<tenant>/generations/<run_id>/objects/<random 64-hex-character id>.age
  media/<tenant>/generations/<run_id>/manifest.json.age

`<tenant>` is validated as a strict slug (lowercase letters, digits and
hyphens, 1-63 characters) at the boundary of both `backup_tenant_media` and
`restore_tenant_media`, before it is used to build a single key -- a `/` or
a `..` in a tenant string can never reach a key, and no tenant's name can
ever be a string-prefix of another tenant's generation keys, because
`generations/` immediately follows the tenant name in every key this module
writes. Object keys are RANDOM, never the live key and never derived from
the plaintext -- both were tried and both leak. The live key is the tenant's
own filename; the plaintext's own SHA-256 is a content fingerprint that
survives the tenant's key being destroyed just as easily, because it is
computed before encryption and needs no key at all to recompute -- anyone
who already knows (or can guess) a piece of content can check a tenant's
backup listing for its hash forever, which is pseudonymisation, not erasure.
A per-tenant HMAC does not fix this either: verifying it needs the HMAC key,
and unless that key is destroyed in lockstep with the tenant's `age`
identity it outlives the erasure the whole scheme exists to provide, which
defeats the point more quietly than the plaintext digest did. So the backup
id carries no relationship to the object's content or its live key at all --
see `generate_backup_object_id` -- and the live-key-to-id mapping, alongside
the plaintext digest restore verification still uses, lives only inside the
encrypted manifest.

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
healthy backup until someone needs to restore from it. That flag is refused
outright -- writing and deleting nothing -- when a previous generation
already holds objects: the flag exists for a brand-new promotion with no
previous generation at all, never to empty a populated one.

GENERATIONS, THE ORDERING GUARANTEE, AND WHY IT SURVIVES TWO RUNS AT ONCE.
Mirroring a tenant's media in place -- keeping storage near 1x rather than
growing without bound -- needs to know which backup object belongs to which
live file, so an unchanged file can be skipped and a removed one deleted.
This pipeline cannot know that without either leaking or holding a secret
(see "Object keys are RANDOM" above: a content- or filename-derived id
leaks, and a per-tenant key to name them safely is a new secret with its own
destruction obligation). `backup_tenant_media` instead never tries to diff
against a previous run at all: every run uploads a complete new set under a
FRESH generation prefix, writes and verifies its own manifest there, then
deletes every key under this tenant's `generations/` prefix whose run id
sorts strictly BEFORE this run's own -- never a key belonging to a run id
that sorts the same or after, whether or not that other run has finished.

That last clause is what makes two overlapping runs of the same tenant safe
with no lock and no new secret. Call the two runs' ids R1 < R2, whichever
order they happen to finish in:

  - Whichever run finishes FIRST only ever deletes generations older than
    ITS OWN id -- the other run's id, R1 or R2, is never less than the
    finishing run's own id if it is the smaller one, and a bigger id is
    never "older" regardless of how much of that run has landed. So the
    still-running or not-yet-started run's generation, complete or not, is
    never touched by the other one finishing.
  - R2 (the larger id) finishing, whenever that happens, deletes R1's whole
    generation (verified-complete or still partial) along with anything
    older -- R2 is definitionally the newest surviving generation once it
    completes, and `restore_tenant_media` always reads the newest.
  - The one edge case -- R2 finishes WHILE R1 is still mid-upload, and R2's
    cleanup removes objects R1 already wrote under R1's own prefix (fair
    game: R1's id sorts before R2's, complete or not) -- is caught by R1's
    own before-any-delete check (see below) rather than silently producing
    a manifest that names objects that are gone: R1 raises and deletes
    nothing, leaving R2 as the sole, correct, fully verified generation.

So there is no interleaving of two same-tenant runs that leaves the
tenant's *current* (highest-id) generation unrestorable -- the losing run
either finishes first (and is later superseded intact) or finishes last (and
supersedes the other), and the one case that could corrupt the winner is
refused by construction rather than merely made unlikely.

THE DELETE STEP IS TRUSTED WITH NOTHING UNTIL THE NEW GENERATION IS PROVEN
DURABLE, ON BOTH AXES A `2xx` RESPONSE CANNOT COVER. Immediately after the
new manifest is PUT, `backup_tenant_media` reads it straight back with
`get_object` and compares the bytes to what was sent -- this endpoint's own
2xx is not proof a write landed. Separately, and just as load-bearing:
before any delete runs, this module lists this tenant's whole
`generations/` prefix fresh and refuses -- raising, deleting nothing --
unless every object key this run itself wrote is present in that listing.
An object PUT that answered 2xx without actually persisting reaches exactly
that check and is caught by it, the same way the manifest's own read-back
catches the manifest's. Only once both hold does deletion run; any failure
before either of them -- an upload, an encrypt, the floor, the manifest
write or its read-back, or a written object gone missing from the listing --
raises first and deletes nothing, so a partial, failed, or superseded run
never removes a generation that is still the tenant's newest verified one.

The same listing this check reads from is also where the delete set comes
from, and every key in it is matched against this module's own exact key
shape (tenant, `generations/<run id>/`, then either `objects/<64 hex>.age`
or `manifest.json.age`) before it is trusted for either purpose -- a listing
that somehow returned a key outside that shape (a bug elsewhere, a forged
object, a `prefix` argument silently ignored) aborts the run rather than
being folded into a presence check or a delete decision it was never meant
to answer.

Deletion is a plain `DeleteObject`, never a version-scoped
`DeleteObjectVersion`: the workload credential this pipeline runs under is
fenced from that action the same way it is fenced from every other
bucket-administration action (see `db/provision/configure_backup_bucket.py`
and the bucket fence it applies), so a plain delete -- which a versioned
bucket turns into a delete marker over the still-readable prior version, not
a destruction -- is the only kind of delete this pipeline is even able to
issue. The bytes are actually reclaimed days later by the backup bucket's
own short, `media/`-scoped noncurrent-version-expiry lifecycle rule, not by
this pipeline. A delete that itself fails partway (one key errors, the rest
were never attempted) leaves an orphan that is not a correctness problem: it
sits under an older run id, so the next successful run's own delete step
picks it up the same way.
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
    """A fresh listing of this tenant's `generations/` prefix, taken right
    before the delete step, does not contain every object key this run
    itself just wrote. Distinguished from `MediaBackupError` so a caller and
    a test can tell this control apart from the manifest's own read-back:
    this is what catches an object PUT that answered 2xx without actually
    persisting, or an older-but-still-technically-concurrent run's cleanup
    removing this run's own objects out from under it -- either way, this
    run's own manifest cannot be trusted while any object it names is
    missing, so nothing is deleted and the run raises instead."""


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
    """Lists this tenant's whole `generations/` prefix and returns
    `(run_id, manifest_key)` for the lexicographically greatest run id that
    actually has a manifest present in the listing -- a generation with no
    manifest is an orphan (an aborted or a superseded-while-still-uploading
    run) and is never a restore candidate. Returns `None` if no generation
    has one. Every key considered is checked against this tenant's exact key
    shape first; anything else in the listing is ignored here (restore reads
    are not the place that refuses on an unexpected key -- `backup_tenant_media`'s
    delete-time check is, since restore never deletes anything)."""
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


def _verify_and_delete_older_generations(
    *,
    tenant: str,
    run_id: str,
    backup_bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    written_this_run: set[str],
    list_objects,
    delete_object,
) -> list[str]:
    """One fresh listing of this tenant's whole `generations/` prefix, used
    for both of this step's jobs: refusing to delete anything unless every
    object THIS run wrote is present in it (see
    `MediaBackupObjectVerificationError`), and computing which generations
    are strictly older than this run's own id -- the only ones this call
    ever deletes, regardless of whether a same-tenant run with a NEWER id is
    mid-flight at the same moment. See the module docstring's "GENERATIONS,
    THE ORDERING GUARANTEE" section for why that is enough to make two
    overlapping runs safe with no lock."""
    prefix = _tenant_generations_prefix(tenant)
    pattern = _generation_key_pattern(tenant)
    existing = list_objects(
        bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        prefix=prefix,
    )

    listed_keys: set[str] = set()
    older_keys: list[str] = []
    for entry in existing:
        key = entry["key"]
        match = pattern.match(key)
        if not match:
            raise MediaBackupError(
                f"tenant {tenant!r}: an object under {prefix!r} does not match this "
                f"module's own key shape: {key!r} -- refusing to reason about deletion "
                f"while a listing scoped to this tenant contains a key this module never "
                f"wrote"
            )
        listed_keys.add(key)
        if match.group("run_id") < run_id:
            older_keys.append(key)

    missing = written_this_run - listed_keys
    if missing:
        raise MediaBackupObjectVerificationError(
            f"tenant {tenant!r}, run {run_id!r}: {len(missing)} object(s) this run itself "
            f"just wrote are not present in a fresh listing of {prefix!r} -- a 2xx on the "
            f"PUT is not proof a write landed. Refusing to delete anything while this run's "
            f"own manifest names objects that cannot be found. One missing key: "
            f"{sorted(missing)[0]!r}"
        )

    for key in sorted(older_keys):
        delete_object(
            bucket=backup_bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            key=key,
        )
    return sorted(older_keys)


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
    """Pulls every object in `live_bucket`, encrypts each to `recipient`, and
    writes the ciphertext plus an encrypted manifest to `backup_bucket`
    under a fresh generation prefix -- then, once that new manifest is
    proven durable AND every object this run wrote is proven present, deletes
    every generation under this tenant's own prefix that is strictly older
    than this run's (see the module docstring for why this mirrors the
    tenant's media in place without a map, a new secret, or a lock, and why
    it stays correct under two overlapping runs of the same tenant).

    Refuses -- raising `MediaBackupFloorError` and writing nothing -- if the
    live bucket lists zero objects, UNLESS `confirm_tenant_has_no_media` is
    explicitly `True`. That flag is not a convenience default: passing it is
    how a caller who genuinely knows this tenant has no media (a brand-new
    promotion, checked against the promotion record, never inferred from the
    listing being empty) says so, and only that assertion is allowed to write
    a manifest recording zero objects -- which is also the only kind of
    empty manifest `restore_tenant_media` will accept as a real restore
    rather than refuse outright. The flag is itself refused -- raising
    `MediaBackupConfirmedEmptyConflictError`, writing and deleting nothing --
    if a previous generation for this tenant already holds objects: it is
    meant for a tenant with no previous generation at all, not for emptying
    one that exists."""
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

    manifest_objects: dict[str, dict] = {}
    new_backup_keys: set[str] = set()
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

    # THE ORDERING GUARANTEE. Nothing above this line can have deleted
    # anything -- these two calls are the first and only place in this
    # function that another generation is ever touched, and the second does
    # not run unless the first returns without raising. See the module
    # docstring's "THE DELETE STEP IS TRUSTED WITH NOTHING" section.
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
    deleted_previous_keys = _verify_and_delete_older_generations(
        tenant=tenant,
        run_id=run_id,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        written_this_run=new_backup_keys,
        list_objects=list_objects,
        delete_object=delete_object,
    )

    return BackupReport(
        tenant=tenant,
        run_id=run_id,
        objects=manifest_objects,
        deliberately_empty=deliberately_empty,
        deleted_previous_keys=deleted_previous_keys,
    )


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
    list_objects=_default_list_objects,
    get_object=_default_get_object,
    put_object=_default_put_object,
    decrypt=decrypt_with_age,
) -> RestoreReport:
    """Finds this tenant's NEWEST generation (the highest-sorting run id
    with a manifest present -- see `find_newest_generation`), then decrypts
    every object that generation's manifest names and checksum-compares it
    against the digest recorded at backup time. Raises
    `MediaRestoreVerificationError` and returns nothing -- the RETURN VALUE
    is never partial -- on the first object that is missing from the backup
    bucket, that decrypts to different bytes than the manifest recorded, or
    that the given identity cannot decrypt at all; also raises if the
    manifest names zero objects without `deliberately_empty: true`, the same
    R4 shape as a missing or corrupt object, or if no generation with a
    manifest exists at all. When `target_bucket` is given, each object
    already verified before a later failure has ALREADY been written there
    -- a partial restore on disk is real and intended (the objects that did
    verify are genuinely recovered), only the return value and exit code are
    all-or-nothing. Each object's backup-bucket key comes from `backup_id`
    in the manifest, never derived from the live key here; the live key
    itself is only ever used as the write path into `target_bucket`, and is
    checked by `_assert_safe_live_key` immediately before that write -- a
    decrypted manifest is not thereby a trusted one."""
    _assert_valid_tenant_slug(tenant, MediaRestoreVerificationError)

    found = find_newest_generation(
        tenant=tenant,
        backup_bucket=backup_bucket,
        endpoint=endpoint,
        region=region,
        access_key=backup_access_key,
        secret_key=backup_secret_key,
        list_objects=list_objects,
    )
    if found is None:
        raise MediaRestoreVerificationError(
            f"tenant {tenant!r}: no generation with a manifest under "
            f"{_tenant_generations_prefix(tenant)!r} in {backup_bucket!r} -- nothing to "
            f"restore, or the backup never ran"
        )
    run_id, manifest_key = found

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

    manifest = json.loads(decrypt(data=manifest_ciphertext, identity_path=identity_path))
    if manifest.get("tenant") != tenant:
        raise MediaRestoreVerificationError(
            f"manifest at {manifest_key!r} names tenant {manifest.get('tenant')!r}, expected "
            f"{tenant!r} -- refusing a cross-tenant restore"
        )

    manifest_objects = manifest.get("objects") or {}
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
        backup_key = _object_key_for_backup(tenant, run_id, expected["backup_id"])
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

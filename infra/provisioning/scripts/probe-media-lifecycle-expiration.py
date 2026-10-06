#!/usr/bin/env python3
"""Settle whether a noncurrent-only lifecycle rule expires the CURRENT version
too on Hetzner Object Storage. Only elapsed wall-clock time against a real
probe and control object can settle it — a configuration round trip cannot.
See probe-media-lifecycle-expiration.md#module-overview.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shared_objectstorage import ObjectStorageError, signed_request  # noqa: E402

# `configure_backup_bucket.lifecycle_document` is the REAL document this
# probe's prefix-split mode exists to prove safe — loaded by path rather
# than reimplemented, since a hand-copied shape can drift and a probe
# testing its own drift proves nothing. One-way only: `db/provision/` ships
# standalone to db1 via `scp -r` and must never import back from here.
# See probe-media-lifecycle-expiration.md#loading-configure_backup_bucket.
_CONFIGURE_BACKUP_BUCKET_SOURCE = (
    pathlib.Path(__file__).resolve().parents[3] / "db" / "provision" / "configure_backup_bucket.py"
)


def _load_configure_backup_bucket():
    if not _CONFIGURE_BACKUP_BUCKET_SOURCE.is_file():
        raise ImportError(
            f"the real lifecycle document builder is not at {_CONFIGURE_BACKUP_BUCKET_SOURCE}. "
            f"Check out the whole of branchLeft/ghost-platform rather than the scripts "
            f"directory alone."
        )
    spec = importlib.util.spec_from_file_location(
        "branchleft_configure_backup_bucket", _CONFIGURE_BACKUP_BUCKET_SOURCE
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"{_CONFIGURE_BACKUP_BUCKET_SOURCE} could not be loaded as a Python module")
    module = importlib.util.module_from_spec(spec)
    # configure_backup_bucket.py imports its OWN sibling, `objectstorage`,
    # by bare module name (it is normally run with db/provision/ as its own
    # directory, per db/RUNBOOK-db.md's `scp -r` deployment). Loading it by
    # path from a different directory needs that sibling importable the
    # same way its own script entry point already makes it -- inserted
    # ahead of anything else on sys.path so it cannot pick up an unrelated
    # same-named module from elsewhere on the path.
    sibling_dir = str(_CONFIGURE_BACKUP_BUCKET_SOURCE.parent)
    added = sibling_dir not in sys.path
    if added:
        sys.path.insert(0, sibling_dir)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise ImportError(f"{_CONFIGURE_BACKUP_BUCKET_SOURCE} could not be executed: {error!r}") from error
    finally:
        if added:
            sys.path.remove(sibling_dir)
    return module


_configure_backup_bucket = _load_configure_backup_bucket()

# The one prefix this script will write under. A structural refusal, not a
# reminder: any other bucket name is refused before a single request is
# signed, because the probe object is deliberately never protected by a
# bucket policy. `check()` enforces this too, on the bucket named in the
# RECEIPT rather than an operator-typed flag.
# See probe-media-lifecycle-expiration.md#probe_bucket_prefix.
PROBE_BUCKET_PREFIX = "branchleft-lifecycle-probe-"

# Named explicitly, belt-and-braces on top of the prefix check above: these
# are the buckets a typo could plausibly produce and the ones where a mistake
# is least recoverable.
NEVER_PROBE_BUCKETS = frozenset({"branchleft-db-backups", "branchleft-pulumi-state"})

# The rule shape under test -- byte-for-byte what render-media-bucket-policy.py
# emits by default, with NoncurrentDays parametrised so the same ambiguity can
# be settled in 24-48h instead of 30 days, and the element set switchable to
# match configure_backup_bucket.py's narrower shape. See the module docstring:
# adding any element neither generator emits answers a different, easier
# question.
DEFAULT_NONCURRENT_DAYS = 1
ABORT_MULTIPART_DAYS = 7

# media: render-media-bucket-policy.py's shape (NoncurrentVersionExpiration +
# AbortIncompleteMultipartUpload). backup: configure_backup_bucket.py's
# narrower shape (NoncurrentVersionExpiration alone). Whether the difference
# is material is exactly what running both shapes separately is for -- see
# "THE BACKUP BUCKET IS A SEPARATE CLAIM" above.
RULE_SHAPES = {"media": True, "backup": False}

# The probe key is covered by the rule's Filter; the control key deliberately
# is not, by prefix -- it is the discriminator between "the rule did this" and
# "something else touched the bucket". Neither is ever overwritten: an object
# that is superseded acquires a noncurrent version under either reading,
# which is a question this test does not need to ask.
PROBE_OBJECT_PREFIX = "probe/"
CONTROL_OBJECT_PREFIX = "control/"
PROBE_OBJECT_KEY = f"{PROBE_OBJECT_PREFIX}canary"
CONTROL_OBJECT_KEY = f"{CONTROL_OBJECT_PREFIX}canary"
PROBE_OBJECT_BODY = b"branchleft media-lifecycle expiration probe -- do not delete by hand\n"
CONTROL_OBJECT_BODY = (
    b"branchleft media-lifecycle expiration probe CONTROL -- outside the rule's Filter "
    b"on purpose; do not delete by hand\n"
)

# PREFIX-SPLIT MODE -- see the module docstring's own section. Byte-for-byte
# the two prefixes db/provision/configure_backup_bucket.py's real lifecycle
# document scopes its rules to; one database-style prefix stands in for both
# `dumps/` and `binlogs/`, which carry the identical rule.
SPLIT_MEDIA_PREFIX = "media/"
SPLIT_DB_PREFIX = "dumps/"
SPLIT_PREFIXES = {"media": SPLIT_MEDIA_PREFIX, "db": SPLIT_DB_PREFIX}
# The real values C-refresh ships, not a shortened stand-in: this mode
# exists to prove THESE numbers are safe, not a proxy for them.
SPLIT_MEDIA_NONCURRENT_DAYS = 1
SPLIT_DB_NONCURRENT_DAYS = 35
SPLIT_OBJECT_BODY = (
    b"branchleft media-lifecycle PREFIX-SPLIT probe -- do not delete by hand\n"
)


class ProbeInputError(ValueError):
    """A value that would point this script at the wrong bucket."""


def _bare_host(endpoint: str) -> str:
    """The bare host to sign for. Mirrors `verify-bucket-fence.py`'s
    `_endpoint_host`: a non-TLS endpoint is refused rather than normalised,
    because every request here carries a live credential in an
    `Authorization` header."""
    if "//" not in endpoint:
        return endpoint.strip("/")
    if not endpoint.startswith("https://"):
        raise ProbeInputError(
            f"--endpoint must be https; {endpoint!r} would send a signed credential in the clear"
        )
    return endpoint[len("https://") :].strip("/")


def assert_bucket_is_disposable(bucket: str) -> None:
    if bucket in NEVER_PROBE_BUCKETS:
        raise ProbeInputError(
            f"{bucket!r} is a real operational bucket. This script writes an unprotected "
            f"object into whatever bucket it is given and leaves a lifecycle rule running "
            f"on it unattended for days -- refusing to target anything but a "
            f"{PROBE_BUCKET_PREFIX!r}-prefixed throwaway bucket."
        )
    if not bucket.startswith(PROBE_BUCKET_PREFIX):
        raise ProbeInputError(
            f"bucket {bucket!r} does not start with {PROBE_BUCKET_PREFIX!r}. This probe is "
            f"destructive-by-design on whatever bucket it is pointed at -- it must be a "
            f"bucket created solely for this test, never a tenant's media bucket and never "
            f"an operational one."
        )


def _versioning_document() -> bytes:
    # Identical to configure_backup_bucket.py's versioning_document() -- the
    # one XML shape this codebase has already had accepted for `?versioning`.
    return (
        b'<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        b"<Status>Enabled</Status></VersioningConfiguration>"
    )


def lifecycle_document(noncurrent_days: int, include_abort_multipart_upload: bool = True) -> bytes:
    # Every element here is one render-media-bucket-policy.py or
    # configure_backup_bucket.py already emits successfully. Nothing new.
    # `Filter/Prefix` is PROBE_OBJECT_PREFIX, not empty -- scoping the rule to
    # the probe key on purpose, so the control key is provably outside it
    # regardless of which reading is true.
    abort_multipart = (
        f"<AbortIncompleteMultipartUpload><DaysAfterInitiation>{ABORT_MULTIPART_DAYS}"
        "</DaysAfterInitiation></AbortIncompleteMultipartUpload>"
        if include_abort_multipart_upload
        else ""
    )
    return (
        '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        "<Rule><ID>branchleft-lifecycle-probe</ID><Status>Enabled</Status>"
        f"<Filter><Prefix>{PROBE_OBJECT_PREFIX}</Prefix></Filter>"
        f"<NoncurrentVersionExpiration><NoncurrentDays>{noncurrent_days}</NoncurrentDays>"
        "</NoncurrentVersionExpiration>"
        f"{abort_multipart}"
        "</Rule></LifecycleConfiguration>"
    ).encode()


def prefix_split_lifecycle_document(
    media_noncurrent_days: int = SPLIT_MEDIA_NONCURRENT_DAYS,
    db_noncurrent_days: int = SPLIT_DB_NONCURRENT_DAYS,
) -> bytes:
    """The REAL document, built by calling `configure_backup_bucket.py`'s own
    `lifecycle_document()` directly rather than a hand-copied reconstruction,
    so the document under test is the one that will actually be applied.
    See probe-media-lifecycle-expiration.md#prefix_split_lifecycle_document."""
    return _configure_backup_bucket.lifecycle_document(
        noncurrent_days=db_noncurrent_days, media_noncurrent_days=media_noncurrent_days
    )


def _local_name(tag: str) -> str:
    """Strips the S3 XML namespace off an ElementTree tag, the same way
    `db/provision/objectstorage.py`'s own helper of the same name does for
    Hetzner's RGW responses."""
    return tag.rsplit("}", 1)[-1]


def _list_object_versions(
    *, host: str, region: str, access_key: str, secret_key: str, bucket: str, prefix: str,
) -> list[dict]:
    """Every version and delete marker under `prefix`, as
    `[{"key", "version_id", "is_latest", "kind": "version"|"delete_marker"}, ...]`.

    The `?versions` sub-resource is the only way to see a version id that
    `NoncurrentVersionExpiration` may since have pruned -- a bare GET/HEAD
    only ever answers about whatever is CURRENT at a key, and a pruned
    version leaves no trace there at all. Paginates on
    `IsTruncated`/`NextKeyMarker`/`NextVersionIdMarker`; a `Filter/Prefix`
    rule and this listing are scoped from the same string so the two can
    never silently drift apart."""
    entries: list[dict] = []
    key_marker: str | None = None
    version_id_marker: str | None = None
    for _ in range(50):
        query = {"versions": "", "prefix": prefix}
        if key_marker is not None:
            query["key-marker"] = key_marker
        if version_id_marker is not None:
            query["version-id-marker"] = version_id_marker
        status, body = signed_request(
            method="GET", endpoint=host, region=region, access_key=access_key,
            secret_key=secret_key, bucket=bucket, query=query,
        )
        if not 200 <= status < 300:
            raise ObjectStorageError(
                f"GET {bucket}?versions&prefix={prefix} failed: HTTP {status}: {body!r}"
            )
        root = ET.fromstring(body)
        truncated = False
        next_key_marker = None
        next_version_id_marker = None
        for child in root:
            name = _local_name(child.tag)
            if name in ("Version", "DeleteMarker"):
                fields = {_local_name(g.tag): (g.text or "") for g in child}
                key, version_id = fields.get("Key"), fields.get("VersionId")
                if key and version_id:
                    entries.append(
                        {
                            "key": key,
                            "version_id": version_id,
                            "is_latest": fields.get("IsLatest", "").strip().lower() == "true",
                            "kind": "delete_marker" if name == "DeleteMarker" else "version",
                        }
                    )
            elif name == "IsTruncated":
                truncated = (child.text or "").strip().lower() == "true"
            elif name == "NextKeyMarker" and (child.text or "").strip():
                next_key_marker = child.text.strip()
            elif name == "NextVersionIdMarker" and (child.text or "").strip():
                next_version_id_marker = child.text.strip()
        if not truncated:
            return entries
        if not next_key_marker and not next_version_id_marker:
            raise ObjectStorageError(
                f"GET {bucket}?versions&prefix={prefix}: IsTruncated=true but no marker to "
                f"resume from -- the listing may be incomplete"
            )
        key_marker, version_id_marker = next_key_marker, next_version_id_marker
    raise ObjectStorageError(f"GET {bucket}?versions&prefix={prefix}: did not finish within 50 pages")


def _only_noncurrent_version_id(versions: list[dict], key: str) -> str:
    """The single noncurrent (non-latest, non-delete-marker) version id
    recorded for `key`, immediately after `setup-split` made it noncurrent --
    raises if the listing does not show exactly one, since a receipt
    recording an ambiguous starting point would make `check-split`'s later
    verdict meaningless."""
    matches = [
        v["version_id"] for v in versions
        if v["key"] == key and v["kind"] == "version" and not v["is_latest"]
    ]
    if len(matches) != 1:
        raise ObjectStorageError(
            f"expected exactly one noncurrent version of {key!r} immediately after it was "
            f"superseded, found {len(matches)}: {matches!r}"
        )
    return matches[0]


def _put_bucket_subresource(
    *, bucket: str, endpoint: str, region: str, access_key: str, secret_key: str,
    subresource: str, body: bytes, needs_content_md5: bool,
) -> None:
    extra_headers = None
    if needs_content_md5:
        digest = hashlib.md5(body, usedforsecurity=False).digest()
        extra_headers = {"content-md5": base64.b64encode(digest).decode()}
    status, response_body = signed_request(
        method="PUT",
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        bucket=bucket,
        query={subresource: ""},
        payload=body,
        extra_headers=extra_headers,
    )
    if not 200 <= status < 300:
        raise ObjectStorageError(
            f"PUT {bucket}?{subresource} failed: HTTP {status}: {response_body!r}"
        )


def _put_object(
    *, bucket: str, endpoint: str, region: str, access_key: str, secret_key: str,
    key: str, body: bytes,
) -> None:
    status, response_body = signed_request(
        method="PUT", endpoint=endpoint, region=region, access_key=access_key,
        secret_key=secret_key, bucket=bucket, key=key, payload=body, content_type="text/plain",
    )
    if not 200 <= status < 300:
        raise ObjectStorageError(f"PUT {bucket}/{key} failed: HTTP {status}: {response_body!r}")


def setup(
    *, bucket: str, endpoint: str, region: str, access_key: str, secret_key: str,
    noncurrent_days: int, receipt_path: pathlib.Path, rule_shape: str = "media",
) -> str:
    """Enable versioning, apply the rule under test, upload the probe and
    control objects, and write a receipt `check` reads back. Returns the
    report printed to the operator."""
    assert_bucket_is_disposable(bucket)
    if rule_shape not in RULE_SHAPES:
        raise ProbeInputError(
            f"--rule-shape {rule_shape!r} is not one of {sorted(RULE_SHAPES)}"
        )
    if receipt_path.exists():
        raise ProbeInputError(
            f"{receipt_path} already exists -- this script does not overwrite a receipt, "
            f"because re-running setup would either re-upload the same key (a no-op) or "
            f"target a different key (splitting the receipt from the object it describes). "
            f"Delete it only once you are certain no probe is in flight."
        )
    host = _bare_host(endpoint)

    _put_bucket_subresource(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, subresource="versioning", body=_versioning_document(),
        needs_content_md5=False,
    )
    lifecycle_body = lifecycle_document(noncurrent_days, RULE_SHAPES[rule_shape])
    _put_bucket_subresource(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, subresource="lifecycle", body=lifecycle_body,
        needs_content_md5=True,
    )

    _put_object(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, key=PROBE_OBJECT_KEY, body=PROBE_OBJECT_BODY,
    )
    _put_object(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, key=CONTROL_OBJECT_KEY, body=CONTROL_OBJECT_BODY,
    )

    uploaded_at = datetime.datetime.now(datetime.timezone.utc)
    earliest_decisive_check = uploaded_at + datetime.timedelta(days=noncurrent_days + 1)
    receipt = {
        "bucket": bucket,
        "endpoint": endpoint,
        "region": region,
        "probe_key": PROBE_OBJECT_KEY,
        "control_key": CONTROL_OBJECT_KEY,
        "rule_shape": rule_shape,
        "noncurrent_days": noncurrent_days,
        "uploaded_at": uploaded_at.isoformat(),
        "earliest_decisive_check": earliest_decisive_check.isoformat(),
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")

    return (
        f"setup complete on {bucket}: versioning enabled, {rule_shape}-shaped lifecycle rule "
        f"applied (NoncurrentDays={noncurrent_days}, "
        f"AbortIncompleteMultipartUpload={'present' if RULE_SHAPES[rule_shape] else 'absent'}, "
        f"no current-version Expiration), {PROBE_OBJECT_KEY!r} and {CONTROL_OBJECT_KEY!r} "
        f"uploaded at {uploaded_at.isoformat()}.\n"
        f"Receipt written to {receipt_path}.\n"
        f"Run `check` no earlier than {earliest_decisive_check.isoformat()} -- "
        f"before that, RGW's daily lifecycle pass has not necessarily run yet and "
        f"a survival reading would not be decisive."
    )


def setup_prefix_split(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    media_noncurrent_days: int = SPLIT_MEDIA_NONCURRENT_DAYS,
    db_noncurrent_days: int = SPLIT_DB_NONCURRENT_DAYS,
    receipt_path: pathlib.Path,
) -> str:
    """See the module docstring's PREFIX-SPLIT MODE section. Enables
    versioning, applies the two-rule split, then under EACH prefix creates a
    control object (current, never touched again), a noncurrent-making
    overwrite, and a noncurrent-making delete -- recording the two resulting
    noncurrent version ids in the receipt immediately, because that is the
    only moment a bare listing is guaranteed to still show them."""
    assert_bucket_is_disposable(bucket)
    if receipt_path.exists():
        raise ProbeInputError(
            f"{receipt_path} already exists -- this script does not overwrite a receipt. "
            f"Delete it only once you are certain no probe is in flight."
        )
    host = _bare_host(endpoint)

    _put_bucket_subresource(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, subresource="versioning", body=_versioning_document(),
        needs_content_md5=False,
    )
    lifecycle_body = prefix_split_lifecycle_document(media_noncurrent_days, db_noncurrent_days)
    _put_bucket_subresource(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, subresource="lifecycle", body=lifecycle_body,
        needs_content_md5=True,
    )

    receipt_prefixes: dict[str, dict] = {}
    for label, prefix in SPLIT_PREFIXES.items():
        control_key = f"{prefix}control/canary"
        noncurrent_key = f"{prefix}noncurrent/canary"
        deleted_key = f"{prefix}deleted/canary"

        _put_object(
            bucket=bucket, endpoint=host, region=region, access_key=access_key,
            secret_key=secret_key, key=control_key, body=SPLIT_OBJECT_BODY,
        )
        _put_object(
            bucket=bucket, endpoint=host, region=region, access_key=access_key,
            secret_key=secret_key, key=noncurrent_key, body=SPLIT_OBJECT_BODY + b"v1\n",
        )
        _put_object(
            bucket=bucket, endpoint=host, region=region, access_key=access_key,
            secret_key=secret_key, key=noncurrent_key, body=SPLIT_OBJECT_BODY + b"v2\n",
        )
        _put_object(
            bucket=bucket, endpoint=host, region=region, access_key=access_key,
            secret_key=secret_key, key=deleted_key, body=SPLIT_OBJECT_BODY,
        )
        status, body = signed_request(
            method="DELETE", endpoint=host, region=region, access_key=access_key,
            secret_key=secret_key, bucket=bucket, key=deleted_key,
        )
        if not 200 <= status < 300:
            raise ObjectStorageError(f"DELETE {bucket}/{deleted_key} failed: HTTP {status}: {body!r}")

        versions = _list_object_versions(
            host=host, region=region, access_key=access_key, secret_key=secret_key,
            bucket=bucket, prefix=prefix,
        )
        receipt_prefixes[label] = {
            "prefix": prefix,
            "control_key": control_key,
            "noncurrent_key": noncurrent_key,
            "noncurrent_version_id": _only_noncurrent_version_id(versions, noncurrent_key),
            "deleted_key": deleted_key,
            "deleted_prior_version_id": _only_noncurrent_version_id(versions, deleted_key),
        }

    uploaded_at = datetime.datetime.now(datetime.timezone.utc)
    # The media side is the one expected to CHANGE -- the db side's decisive
    # answer (still present) is valid from the moment setup finishes, since
    # nothing legitimate removes it sooner than its own long rule allows.
    earliest_decisive_check = uploaded_at + datetime.timedelta(days=media_noncurrent_days + 1)
    receipt = {
        "bucket": bucket,
        "endpoint": endpoint,
        "region": region,
        "media_noncurrent_days": media_noncurrent_days,
        "db_noncurrent_days": db_noncurrent_days,
        "uploaded_at": uploaded_at.isoformat(),
        "earliest_decisive_check": earliest_decisive_check.isoformat(),
        "prefixes": receipt_prefixes,
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")

    return (
        f"prefix-split setup complete on {bucket}: versioning enabled, two-rule split applied "
        f"(media/ NoncurrentDays={media_noncurrent_days}, dumps/ (representing dumps/+binlogs/) "
        f"NoncurrentDays={db_noncurrent_days}); under each prefix, a control object plus a "
        f"noncurrent version from an overwrite and one from a delete were created and their "
        f"version ids recorded.\n"
        f"Receipt written to {receipt_path}.\n"
        f"Run `check-split` no earlier than {earliest_decisive_check.isoformat()}."
    )


def _head(*, host: str, region: str, access_key: str, secret_key: str, bucket: str, key: str):
    return signed_request(
        method="HEAD", endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, bucket=bucket, key=key,
    )


def check(*, receipt_path: pathlib.Path, access_key: str, secret_key: str) -> str:
    if not receipt_path.exists():
        raise ProbeInputError(f"{receipt_path} does not exist -- run `setup` first")
    receipt = json.loads(receipt_path.read_text())
    # The receipt names the bucket this credential is about to read -- refuse
    # BEFORE any request is signed, exactly as `setup` refuses before its
    # first write. A receipt is a plain JSON file an operator can hand-edit
    # or mix up with another run's; nothing about `check` running read-only
    # licenses skipping the same guard `setup` applies.
    assert_bucket_is_disposable(receipt["bucket"])
    host = _bare_host(receipt["endpoint"])
    now = datetime.datetime.now(datetime.timezone.utc)
    earliest = datetime.datetime.fromisoformat(receipt["earliest_decisive_check"])
    elapsed = now - datetime.datetime.fromisoformat(receipt["uploaded_at"])
    rule_shape = receipt.get("rule_shape", "media")

    probe_status, probe_body = _head(
        host=host, region=receipt["region"], access_key=access_key, secret_key=secret_key,
        bucket=receipt["bucket"], key=receipt["probe_key"],
    )
    control_status, control_body = _head(
        host=host, region=receipt["region"], access_key=access_key, secret_key=secret_key,
        bucket=receipt["bucket"], key=receipt["control_key"],
    )

    early_warning = "" if now >= earliest else (
        f"\nWARNING: this is {elapsed} after upload, before the earliest decisive check time "
        f"{receipt['earliest_decisive_check']}. A SURVIVES verdict this early is not yet "
        f"decisive -- the daily lifecycle pass may not have run. A GONE-with-control-surviving "
        f"verdict this early is still decisive; nothing legitimate deletes the probe sooner "
        f"than the rule allows."
    )
    detail = f"probe={receipt['probe_key']!r} HTTP {probe_status}, control={receipt['control_key']!r} HTTP {control_status}"

    if probe_status == 200 and control_status == 200:
        return (
            f"SURVIVES ({elapsed} after upload, {detail}) -- READING A for the {rule_shape!r} "
            f"rule shape. Neither object was removed; the rule does not expire a current, "
            f"never-superseded object.{early_warning}"
        )
    if probe_status == 404 and control_status == 200:
        return (
            f"GONE, CONTROL SURVIVES ({elapsed} after upload, {detail}) -- READING B, CONFIRMED "
            f"for the {rule_shape!r} rule shape. The control was never in this rule's Filter "
            f"scope, so its survival attributes the probe's loss to the rule itself, not to the "
            f"bucket or credential. Every bucket carrying this rule shape is losing content on "
            f"the same schedule, right now. Stop here and escalate to Rob before touching any "
            f"live bucket.{early_warning}"
        )
    if probe_status == 404 and control_status == 404:
        return (
            f"INCONCLUSIVE ({elapsed} after upload, {detail}): both objects are gone, but the "
            f"rule under test does not cover the control's key -- its scope cannot explain the "
            f"control's disappearance, so this cannot be attributed to the rule. Investigate the "
            f"bucket (deleted? a broader credential change? manual cleanup?) before drawing any "
            f"conclusion.{early_warning}"
        )
    if probe_status == 200 and control_status == 404:
        return (
            f"INCONCLUSIVE ({elapsed} after upload, {detail}): the probe survives but the control "
            f"-- outside the rule's scope -- is gone. No reading of this rule predicts that "
            f"pattern; investigate rather than trust either half.{early_warning}"
        )
    return (
        f"INCONCLUSIVE ({elapsed} after upload, {detail}, probe body={probe_body!r}, "
        f"control body={control_body!r}): not a clean 200/404 pair on both keys. A transport or "
        f"credential problem is indistinguishable from a deleted object at this layer. Fix the "
        f"transport question and re-run before drawing any conclusion.{early_warning}"
    )


def check_prefix_split(*, receipt_path: pathlib.Path, access_key: str, secret_key: str) -> str:
    """See the module docstring's PREFIX-SPLIT MODE section for the full
    decision table. PASS requires every current object on both prefixes to
    still answer, media/'s two noncurrent version ids to be GONE, and the
    db-style prefix's two noncurrent version ids to still be PRESENT --
    anything else is FAIL or INCONCLUSIVE."""
    if not receipt_path.exists():
        raise ProbeInputError(f"{receipt_path} does not exist -- run `setup-split` first")
    receipt = json.loads(receipt_path.read_text())
    assert_bucket_is_disposable(receipt["bucket"])
    host = _bare_host(receipt["endpoint"])
    now = datetime.datetime.now(datetime.timezone.utc)
    earliest = datetime.datetime.fromisoformat(receipt["earliest_decisive_check"])
    elapsed = now - datetime.datetime.fromisoformat(receipt["uploaded_at"])

    results: dict[str, dict] = {}
    for label, info in receipt["prefixes"].items():
        control_status, _ = _head(
            host=host, region=receipt["region"], access_key=access_key, secret_key=secret_key,
            bucket=receipt["bucket"], key=info["control_key"],
        )
        versions = _list_object_versions(
            host=host, region=receipt["region"], access_key=access_key, secret_key=secret_key,
            bucket=receipt["bucket"], prefix=info["prefix"],
        )
        present_ids = {v["version_id"] for v in versions}
        results[label] = {
            "control_survives": control_status == 200,
            "noncurrent_present": info["noncurrent_version_id"] in present_ids,
            "deleted_prior_present": info["deleted_prior_version_id"] in present_ids,
            "current_of_noncurrent_present": any(
                v["key"] == info["noncurrent_key"] and v["kind"] == "version" and v["is_latest"]
                for v in versions
            ),
            "delete_marker_present": any(
                v["key"] == info["deleted_key"] and v["kind"] == "delete_marker" and v["is_latest"]
                for v in versions
            ),
        }

    media, db = results["media"], results["db"]
    # `control_survives` and `current_of_noncurrent_present` must hold for
    # BOTH prefixes unconditionally. `delete_marker_present` differs for
    # media/ when the bucket was set up with an earlier document whose media/
    # rule carried `ExpiredObjectDeleteMarker`, which can remove the now-sole
    # delete marker once its noncurrent version is pruned. See
    # probe-media-lifecycle-expiration.md#check-split-verdict-fields.
    all_currents_present = all(
        r[field]
        for r in (media, db)
        for field in ("control_survives", "current_of_noncurrent_present")
    ) and db["delete_marker_present"]
    media_pruned = not media["noncurrent_present"] and not media["deleted_prior_present"]
    db_intact = db["noncurrent_present"] and db["deleted_prior_present"]
    media_delete_marker_note = (
        "media/'s delete marker also survives (ExpiredObjectDeleteMarker has not yet acted, "
        "or this engine does not honour it -- inconclusive on that element alone)"
        if media["delete_marker_present"]
        else "media/'s delete marker is ALSO gone -- consistent with ExpiredObjectDeleteMarker "
        "acting once the noncurrent version underneath it was pruned (READING: this engine "
        "honours that element)"
    )

    detail = (
        f"media: control={'survives' if media['control_survives'] else 'GONE'} "
        f"current={'survives' if media['current_of_noncurrent_present'] else 'GONE'} "
        f"delete-marker={'survives' if media['delete_marker_present'] else 'GONE'} "
        f"noncurrent-overwrite={'present' if media['noncurrent_present'] else 'pruned'} "
        f"noncurrent-from-delete={'present' if media['deleted_prior_present'] else 'pruned'}; "
        f"db: control={'survives' if db['control_survives'] else 'GONE'} "
        f"current={'survives' if db['current_of_noncurrent_present'] else 'GONE'} "
        f"delete-marker={'survives' if db['delete_marker_present'] else 'GONE'} "
        f"noncurrent-overwrite={'present' if db['noncurrent_present'] else 'pruned'} "
        f"noncurrent-from-delete={'present' if db['deleted_prior_present'] else 'pruned'}"
    )
    early_warning = "" if now >= earliest else (
        f"\nWARNING: this is {elapsed} after upload, before the earliest decisive check time "
        f"{receipt['earliest_decisive_check']}. media/ not yet pruned is not yet decisive this "
        f"early -- the daily lifecycle pass may not have run. Any current object missing, or "
        f"the db-style prefix losing a noncurrent version, is still decisive even this early."
    )

    if not all_currents_present:
        return (
            f"FAIL ({elapsed} after upload, {detail}): a CURRENT object is missing on at least "
            f"one prefix, or the db-style prefix's own delete marker (which carries no "
            f"ExpiredObjectDeleteMarker) is gone. No reading of either rule predicts either -- "
            f"investigate rather than attribute this to the split working or not."
        )
    if media_pruned and db_intact:
        return (
            f"PASS ({elapsed} after upload, {detail}): media/'s noncurrent content was pruned "
            f"by its own short rule; the db-style prefix's noncurrent content was left alone by "
            f"its own long rule. The two rules stayed independent -- record this in "
            f"14-hetzner-migration-programme.md section 16. Also observed: {media_delete_marker_note}."
            f"{early_warning}"
        )
    if not media_pruned and db_intact:
        verdict = "INCONCLUSIVE" if now < earliest else "FAIL"
        return (
            f"{verdict} ({elapsed} after upload, {detail}): media/'s noncurrent content has not "
            f"been pruned. {'Not yet decisive this early.' if verdict == 'INCONCLUSIVE' else 'Past the earliest decisive check time and still not pruned -- the media/ rule is not acting as expected.'}{early_warning}"
        )
    if media_pruned and not db_intact:
        return (
            f"FAIL ({elapsed} after upload, {detail}): the db-style prefix's noncurrent content "
            f"was pruned even though its own rule sets a 35-day expiry -- the two rules are NOT "
            f"staying independent. Stop and escalate to Rob before touching any live bucket."
        )
    return (
        f"INCONCLUSIVE ({elapsed} after upload, {detail}): neither prefix behaved as either "
        f"reading predicts. Investigate the bucket itself before drawing any "
        f"conclusion.{early_warning}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup_parser = subparsers.add_parser("setup", help="apply the rule and upload the canaries")
    setup_parser.add_argument("--bucket", required=True)
    setup_parser.add_argument("--endpoint", default="https://hel1.your-objectstorage.com")
    setup_parser.add_argument("--region", default="hel1")
    setup_parser.add_argument("--noncurrent-days", type=int, default=DEFAULT_NONCURRENT_DAYS)
    setup_parser.add_argument(
        "--rule-shape", choices=sorted(RULE_SHAPES), default="media",
        help="'media' matches render-media-bucket-policy.py (with AbortIncompleteMultipartUpload); "
        "'backup' matches configure_backup_bucket.py's narrower shape (without it)",
    )
    setup_parser.add_argument("--receipt", required=True, type=pathlib.Path)

    check_parser = subparsers.add_parser("check", help="read back both canaries and give a verdict")
    check_parser.add_argument("--receipt", required=True, type=pathlib.Path)
    # --bucket/--endpoint/--region are not accepted here: they are read from
    # the receipt `setup` wrote, so `check` cannot be pointed at a bucket
    # other than the one it uploaded to by a mistyped flag.

    split_setup_parser = subparsers.add_parser(
        "setup-split", help="prefix-split mode: apply the real two-rule shape and the canaries"
    )
    split_setup_parser.add_argument("--bucket", required=True)
    split_setup_parser.add_argument("--endpoint", default="https://hel1.your-objectstorage.com")
    split_setup_parser.add_argument("--region", default="hel1")
    split_setup_parser.add_argument(
        "--media-noncurrent-days", type=int, default=SPLIT_MEDIA_NONCURRENT_DAYS
    )
    split_setup_parser.add_argument(
        "--db-noncurrent-days", type=int, default=SPLIT_DB_NONCURRENT_DAYS
    )
    split_setup_parser.add_argument("--receipt", required=True, type=pathlib.Path)

    split_check_parser = subparsers.add_parser(
        "check-split", help="prefix-split mode: read back both prefixes and give a verdict"
    )
    split_check_parser.add_argument("--receipt", required=True, type=pathlib.Path)
    # No --bucket/--endpoint/--region here either -- same reasoning as `check`.

    args = parser.parse_args(argv)

    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        print("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set.", file=sys.stderr)
        return 2

    try:
        if args.command == "setup":
            report = setup(
                bucket=args.bucket, endpoint=args.endpoint, region=args.region,
                access_key=access_key, secret_key=secret_key,
                noncurrent_days=args.noncurrent_days, receipt_path=args.receipt,
                rule_shape=args.rule_shape,
            )
        elif args.command == "check":
            report = check(receipt_path=args.receipt, access_key=access_key, secret_key=secret_key)
        elif args.command == "setup-split":
            report = setup_prefix_split(
                bucket=args.bucket, endpoint=args.endpoint, region=args.region,
                access_key=access_key, secret_key=secret_key,
                media_noncurrent_days=args.media_noncurrent_days,
                db_noncurrent_days=args.db_noncurrent_days, receipt_path=args.receipt,
            )
        else:
            report = check_prefix_split(
                receipt_path=args.receipt, access_key=access_key, secret_key=secret_key
            )
    except (ProbeInputError, ObjectStorageError) as error:
        print(f"probe-media-lifecycle-expiration: {error}", file=sys.stderr)
        return 1

    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

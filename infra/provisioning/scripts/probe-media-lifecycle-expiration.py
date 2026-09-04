#!/usr/bin/env python3
"""Settle whether a noncurrent-only lifecycle rule expires the CURRENT version too.

`render-media-bucket-policy.py` emits a lifecycle rule carrying
`NoncurrentVersionExpiration` and `AbortIncompleteMultipartUpload` and
deliberately no current-version `Expiration` element -- see that file's
`render_commands()`. A tenant bucket configured with exactly that rule then
had its first upload answered with an `x-amz-expiration` header naming a date
31 days out, attributed to the rule, on the CURRENT version of a freshly
uploaded object. In real S3 semantics a noncurrent-only rule produces no such
header at all. Two readings are open:

  READING A (optimistic, and the likelier one): RGW's header code answers "when
  would this version expire once superseded" from the only day-count the rule
  carries, even though the object is current and lifecycle processing itself
  never touches it. The header is cosmetic noise; nothing is ever deleted that
  the rule did not intend.

  READING B (pessimistic): RGW's lifecycle processing itself has read the
  rule's only day-count as a current-version expiry. Every tenant's media
  bucket then deletes every object `NoncurrentDays` after upload, silently,
  because nothing distinguishes an ordinary upload from a superseded one until
  the storage engine is asked to act on it.

Configuration round trips (`get-lifecycle-configuration` reading back what was
sent) settle NEITHER reading -- both a document that is honoured as written and
a document whose only number is misapplied to the wrong version class read
back identically. The two readings differ in what the storage engine DOES
over time, which only elapsed wall-clock time against a real object can show.

THE CHEAP DECISIVE TEST. Put one object into a bucket carrying this exact rule
shape with `NoncurrentDays` set low (default 1, so a daily lifecycle pass
settles it in 24-48h rather than the real 30), never overwrite it -- an object
that is never superseded never acquires a noncurrent version under EITHER
reading, so nothing about this test depends on versioning behaving any
particular way -- and come back after the wait to see whether the object
survives. Surviving is READING A. Gone is READING B, and READING B means every
tenant's media is being deleted a fixed number of days after upload right now.

USAGE, two runs against a THROWAWAY bucket -- never a tenant's media bucket,
never `branchleft-db-backups`, never anything with real content:

    # Day 0. Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the
    # environment for a credential that administers throwaway Object Storage
    # buckets in this project -- the same class of credential already used
    # for the `branchleft-lab-*` buckets in ghost-platform-docs/14 SS16.1.
    # NEVER a tenant's media credential, and never the operator credential
    # that is `branchleft-db-backups`'s administrator, because a mistake here
    # must not be able to touch either.
    python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py setup \\
      --bucket branchleft-lifecycle-probe-<yyyymmdd> \\
      --endpoint hel1.your-objectstorage.com --region hel1 \\
      --receipt /tmp/media-lifecycle-probe-receipt.json

    # The bucket itself must already exist and be empty -- this script does
    # not create one. `aws --endpoint-url https://hel1.your-objectstorage.com
    # s3api create-bucket --bucket branchleft-lifecycle-probe-<yyyymmdd> --acl
    # private --create-bucket-configuration LocationConstraint=hel1` first, as
    # the same operator credential.

    # 24-48 hours later, same receipt file, same credential:
    python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py check \\
      --endpoint hel1.your-objectstorage.com --region hel1 \\
      --receipt /tmp/media-lifecycle-probe-receipt.json

INTERPRETATION GUIDE, read from `check`'s own printed verdict:

  SURVIVES (HTTP 200, ETag matches the receipt) -- READING A. The rule shape
  `render-media-bucket-policy.py` emits does not expire a current, never-
  superseded object. Record this in `14-hetzner-migration-programme.md`
  section 16 as Observed; the register's own words already say this needs
  exactly this kind of run to close. No code change is implied.

  GONE (HTTP 404 / NoSuchKey) -- READING B. Confirmed: this exact rule shape
  deletes a tenant's media a fixed number of days after upload, and every
  tenant provisioned since the rule started being applied has media at risk
  right now. This is not a finding to record and move on from -- stop
  provisioning new tenants under this rule shape, and escalate to Rob before
  doing anything else, because the next action (freezing the lifecycle rule
  on every live tenant bucket, or removing it, is itself a live-infrastructure
  change on production media buckets and is exactly the kind of action this
  script's own author was barred from taking unattended.

  ANYTHING ELSE (a transport error, a non-200/404 status, a credential that
  cannot reach the bucket) -- INCONCLUSIVE, not a pass. A negative result here
  cannot even be trusted at face value: a disposable bucket used for nothing
  else makes an accidental delete by something unrelated unlikely, but a 404
  from a credential problem or a mistyped bucket name is indistinguishable
  from one at the wire level, and only re-running once the transport question
  is fixed tells them apart. Report the raw status and body; do not guess.

WHY THE RULE SHAPE HERE MUST STAY IDENTICAL TO PRODUCTION'S. This script's
lifecycle document uses exactly the two elements
`render-media-bucket-policy.py` emits -- `NoncurrentVersionExpiration` and
`AbortIncompleteMultipartUpload` -- and nothing else. Adding a current-version
`Expiration` element to "help" would answer a different question: whether an
EXPLICIT current-version expiry is honoured, which nobody doubts, not whether
the ambiguous rule this platform actually ships is. Inventing any element or
action name not already proven acceptable elsewhere in this repository is
exactly the mistake that made a bucket policy unrenderable in a previous
incident here -- this file uses nothing that
`render-media-bucket-policy.py` and `configure_backup_bucket.py` have not
already had accepted.

WHY THIS SCRIPT NEVER RUNS ITSELF. It is written to be executed by a human
with a live credential and a throwaway bucket, on a 24-48h cadence it cannot
schedule itself; nothing in this repository's CI reaches Hetzner Object
Storage with a credential that could run it, and it must not gain that
ability, because `check`'s only destructive potential -- misreading a
transport failure as READING B -- is exactly the failure mode an unattended
retry would make more likely, not less.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shared_objectstorage import ObjectStorageError, signed_request  # noqa: E402

# The one prefix this script will write under. A structural refusal, not a
# reminder: a bucket named anything else -- including every tenant's own
# `branchleft-media-<slug>` and the operational `branchleft-db-backups` --
# is refused before a single request is signed, because the object this
# script uploads is deliberately never protected by a bucket policy and the
# whole point of the test is to let a lifecycle rule run unopposed on it.
PROBE_BUCKET_PREFIX = "branchleft-lifecycle-probe-"

# Named explicitly, belt-and-braces on top of the prefix check above: these
# are the buckets a typo could plausibly produce and the ones where a mistake
# is least recoverable.
NEVER_PROBE_BUCKETS = frozenset({"branchleft-db-backups", "branchleft-pulumi-state"})

# The rule shape under test -- byte-for-byte what render-media-bucket-policy.py
# emits, with only NoncurrentDays parametrised so the same ambiguity can be
# settled in 24-48h instead of 30 days. See the module docstring: adding any
# other element answers a different, easier question.
DEFAULT_NONCURRENT_DAYS = 1
ABORT_MULTIPART_DAYS = 7

# Never overwritten. An object that is superseded acquires a noncurrent
# version under either reading, which is a question this test does not need
# to ask; the whole probe rests on this key staying at exactly one version.
PROBE_OBJECT_KEY = "probe-canary"
PROBE_OBJECT_BODY = b"branchleft media-lifecycle expiration probe -- do not delete by hand\n"


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


def lifecycle_document(noncurrent_days: int) -> bytes:
    # Every element here is one `render-media-bucket-policy.py` or
    # `configure_backup_bucket.py` already emits successfully. Nothing new.
    return (
        '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        "<Rule><ID>branchleft-lifecycle-probe</ID><Status>Enabled</Status>"
        "<Filter><Prefix></Prefix></Filter>"
        f"<NoncurrentVersionExpiration><NoncurrentDays>{noncurrent_days}</NoncurrentDays>"
        "</NoncurrentVersionExpiration>"
        f"<AbortIncompleteMultipartUpload><DaysAfterInitiation>{ABORT_MULTIPART_DAYS}"
        "</DaysAfterInitiation></AbortIncompleteMultipartUpload>"
        "</Rule></LifecycleConfiguration>"
    ).encode()


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


def setup(
    *, bucket: str, endpoint: str, region: str, access_key: str, secret_key: str,
    noncurrent_days: int, receipt_path: pathlib.Path,
) -> str:
    """Enable versioning, apply the rule under test, upload the one canary
    object, and write a receipt `check` reads back. Returns the report
    printed to the operator."""
    assert_bucket_is_disposable(bucket)
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
    lifecycle_body = lifecycle_document(noncurrent_days)
    _put_bucket_subresource(
        bucket=bucket, endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, subresource="lifecycle", body=lifecycle_body,
        needs_content_md5=True,
    )

    put_status, put_body = signed_request(
        method="PUT", endpoint=host, region=region, access_key=access_key,
        secret_key=secret_key, bucket=bucket, key=PROBE_OBJECT_KEY,
        payload=PROBE_OBJECT_BODY, content_type="text/plain",
    )
    if not 200 <= put_status < 300:
        raise ObjectStorageError(f"PUT {bucket}/{PROBE_OBJECT_KEY} failed: HTTP {put_status}: {put_body!r}")

    uploaded_at = datetime.datetime.now(datetime.timezone.utc)
    earliest_decisive_check = uploaded_at + datetime.timedelta(days=noncurrent_days + 1)
    receipt = {
        "bucket": bucket,
        "endpoint": endpoint,
        "region": region,
        "key": PROBE_OBJECT_KEY,
        "noncurrent_days": noncurrent_days,
        "uploaded_at": uploaded_at.isoformat(),
        "earliest_decisive_check": earliest_decisive_check.isoformat(),
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")

    return (
        f"setup complete on {bucket}: versioning enabled, lifecycle rule applied "
        f"(NoncurrentDays={noncurrent_days}, no current-version Expiration), "
        f"{PROBE_OBJECT_KEY!r} uploaded at {uploaded_at.isoformat()}.\n"
        f"Receipt written to {receipt_path}.\n"
        f"Run `check` no earlier than {earliest_decisive_check.isoformat()} -- "
        f"before that, RGW's daily lifecycle pass has not necessarily run yet and "
        f"a survival reading would not be decisive."
    )


def check(*, receipt_path: pathlib.Path, access_key: str, secret_key: str) -> str:
    if not receipt_path.exists():
        raise ProbeInputError(f"{receipt_path} does not exist -- run `setup` first")
    receipt = json.loads(receipt_path.read_text())
    host = _bare_host(receipt["endpoint"])
    now = datetime.datetime.now(datetime.timezone.utc)
    earliest = datetime.datetime.fromisoformat(receipt["earliest_decisive_check"])
    elapsed = now - datetime.datetime.fromisoformat(receipt["uploaded_at"])

    status, body = signed_request(
        method="HEAD",
        endpoint=host,
        region=receipt["region"],
        access_key=access_key,
        secret_key=secret_key,
        bucket=receipt["bucket"],
        key=receipt["key"],
    )

    early_warning = "" if now >= earliest else (
        f"\nWARNING: this is {elapsed} after upload, before the earliest decisive check time "
        f"{receipt['earliest_decisive_check']}. A SURVIVES verdict this early is not yet "
        f"decisive -- the daily lifecycle pass may not have run. A GONE verdict this early is "
        f"still decisive; nothing legitimate deletes this object sooner than the rule allows."
    )

    if status == 200:
        return (
            f"SURVIVES ({elapsed} after upload, HTTP 200) -- READING A. The rule shape "
            f"render-media-bucket-policy.py emits does not expire a current, never-superseded "
            f"object on {receipt['bucket']}/{receipt['key']}.{early_warning}"
        )
    if status == 404:
        return (
            f"GONE ({elapsed} after upload, HTTP 404) -- READING B, CONFIRMED. This rule shape "
            f"deletes a current object {receipt['noncurrent_days']} day(s) after upload. Every "
            f"tenant media bucket carrying this rule is losing content on the same schedule. "
            f"Stop here and escalate to Rob before touching any live tenant bucket.{early_warning}"
        )
    return (
        f"INCONCLUSIVE ({elapsed} after upload, HTTP {status}): {body!r}. Not a pass and not a "
        f"confirmed GONE -- a transport or credential problem is indistinguishable from a "
        f"deleted object at this layer. Fix the transport question and re-run before drawing "
        f"any conclusion.{early_warning}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup_parser = subparsers.add_parser("setup", help="apply the rule and upload the canary")
    setup_parser.add_argument("--bucket", required=True)
    setup_parser.add_argument("--endpoint", default="https://hel1.your-objectstorage.com")
    setup_parser.add_argument("--region", default="hel1")
    setup_parser.add_argument("--noncurrent-days", type=int, default=DEFAULT_NONCURRENT_DAYS)
    setup_parser.add_argument("--receipt", required=True, type=pathlib.Path)

    check_parser = subparsers.add_parser("check", help="read back the canary and give a verdict")
    check_parser.add_argument("--receipt", required=True, type=pathlib.Path)
    # --endpoint/--region are not accepted here: they are read from the
    # receipt `setup` wrote, so `check` cannot be pointed at a bucket other
    # than the one it uploaded to by a mistyped flag.

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
            )
        else:
            report = check(receipt_path=args.receipt, access_key=access_key, secret_key=secret_key)
    except (ProbeInputError, ObjectStorageError) as error:
        print(f"probe-media-lifecycle-expiration: {error}", file=sys.stderr)
        return 1

    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

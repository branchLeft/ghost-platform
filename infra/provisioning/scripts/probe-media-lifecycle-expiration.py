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

THE CHEAP DECISIVE TEST, AND WHY IT NEEDS TWO OBJECTS NOT ONE. Put one "probe"
object, under a key the rule's `Filter` covers, into a bucket carrying this
exact rule shape with `NoncurrentDays` set low (default 1, so a daily
lifecycle pass settles it in 24-48h rather than the real 30); never overwrite
it, so it never acquires a noncurrent version under EITHER reading and the
test does not depend on versioning behaving any particular way. Alongside it,
put a "control" object under a key the rule's `Filter` does NOT cover -- so no
reading of this rule, optimistic or pessimistic, predicts the control's
removal.

A single object's disappearance is not proof by itself: a 404 is equally
consistent with the bucket having been deleted out from under the probe, a
credential or permission change between the two runs, or unrelated manual
cleanup -- exactly the "a negative result cannot identify which boundary
produced it" trap this whole item is about, and a tool meant to resolve that
ambiguity must not reintroduce it. The control is the discriminator:

  - probe gone, control survives -> only the rule could have done that,
    because the control was never in its scope. READING B, confirmed.
  - probe gone, control ALSO gone -> something removed both, and the rule
    only covers one of them -- attribute nothing to the rule. INCONCLUSIVE.
  - probe survives -> READING A, regardless of the control (which is expected
    to survive too; if it does not, that is its own anomaly, reported as
    INCONCLUSIVE rather than folded into a verdict about the probe).

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
      --receipt /tmp/media-lifecycle-probe-receipt.json

    # A SECOND run, against a SEPARATE throwaway bucket, tests the shape
    # branchleft-db-backups actually carries -- no AbortIncompleteMultipartUpload,
    # and its own 35-day NoncurrentDays (the low default is still fine for a
    # fast answer; only the ELEMENT SET is what needs to match). See "THE
    # BACKUP BUCKET IS A SEPARATE CLAIM" below for why this is not optional:
    python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py setup \\
      --bucket branchleft-lifecycle-probe-<yyyymmdd>-backup-shape \\
      --endpoint hel1.your-objectstorage.com --region hel1 \\
      --rule-shape backup \\
      --receipt /tmp/backup-lifecycle-probe-receipt.json

INTERPRETATION GUIDE, read from `check`'s own printed verdict. Each names
exactly what it does and does not rule out -- there is no ETag or version-id
comparison anywhere in this script: `signed_request`'s transport returns only
`(status, body)`, no headers, so nothing here claims to verify object
identity beyond "a HEAD to this key returned 200 or 404". The control object
is what supplies the missing discriminator instead.

  SURVIVES (probe HTTP 200) -- READING A. The rule shape under test does not
  expire a current, never-superseded object. Record this in
  `14-hetzner-migration-programme.md` section 16 as Observed for the rule
  shape tested (media or backup, per the receipt); the register's own words
  already say this needs exactly this kind of run to close. No code change
  is implied. Does NOT by itself rule out some other object-identity mixup
  (there is no version id or ETag check here) -- it rules out the object at
  this key being gone.

  GONE, CONTROL SURVIVES (probe HTTP 404, control HTTP 200) -- READING B,
  CONFIRMED. The control was never in the rule's `Filter` scope under either
  reading, so its survival while the probe vanished attributes the loss to
  this rule specifically, not to the bucket, credential or account in
  general. Every bucket carrying the SAME rule shape (media or backup, named
  in the receipt) is losing content on the same schedule, right now. Stop
  provisioning new tenants under this rule shape and escalate to Rob before
  touching any live bucket -- freezing or replacing the lifecycle rule on a
  live bucket is itself a production infrastructure change, outside what
  this script or its author may do unattended.

  GONE, CONTROL ALSO GONE (both HTTP 404) -- INCONCLUSIVE, not READING B.
  Something removed both objects, but the rule under test only covers the
  probe's key -- its scope cannot explain the control's disappearance, so
  this result cannot be attributed to the rule. Investigate the bucket
  itself (deleted? a broader credential change? manual cleanup?) before
  drawing any conclusion, and re-run once that is understood.

  PROBE SURVIVES, CONTROL GONE (probe 200, control 404) -- INCONCLUSIVE. No
  reading of this rule predicts the control disappearing while the probe
  does not; this pattern does not match the question this script asks.
  Investigate rather than trust either half.

  ANYTHING ELSE (a transport error, a non-200/404 status on either key, a
  credential that cannot reach the bucket) -- INCONCLUSIVE. Report the raw
  status and body for both keys; do not guess.

THE BACKUP BUCKET IS A SEPARATE CLAIM, NOT AN ASSUMED TRANSFER. A run of this
script proves a result about the rule shape it actually applied.
`branchleft-db-backups` (`db/provision/configure_backup_bucket.py`) carries
`NoncurrentVersionExpiration` alone, at 35 days, with NO
`AbortIncompleteMultipartUpload` element -- a narrower rule than the media
default this script applies. `--rule-shape backup` reproduces that narrower
shape (element set only; `--noncurrent-days` is still yours to lower for a
fast answer). Whether `AbortIncompleteMultipartUpload`'s mere presence
changes how RGW's lifecycle engine reads the sibling
`NoncurrentVersionExpiration` element is not established either way by a
single run -- it is a small, plausible-sounding claim ("an unrelated sibling
element changes this one's interpretation") that nobody has tested, so it is
not assumed here. A media-shape SURVIVES or GONE verdict is evidence, not
proof, about the backup bucket; run `--rule-shape backup` separately for a
claim about it specifically. See branchLeft/ghost-platform#165 for why this
matters: that bucket's current-object retention already depends on
`prune_backups.py`'s own pruning running before anything else deletes the
object it is about to evaluate.

WHY THIS SCRIPT USES NO VOCABULARY BEYOND WHAT IS ALREADY PROVEN. Both rule
shapes here use only elements `render-media-bucket-policy.py` or
`configure_backup_bucket.py` already have accepted: `NoncurrentVersionExpiration`,
`AbortIncompleteMultipartUpload`, `Filter`/`Prefix`, `ID`, `Status`. Adding a
current-version `Expiration` element to "help" would answer a different
question -- whether an EXPLICIT current-version expiry is honoured, which
nobody doubts -- not whether the ambiguous rule this platform actually ships
is safe. Inventing any element or action name not already proven acceptable
elsewhere in this repository is exactly the mistake that made a bucket policy
unrenderable in a previous incident here.

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
#
# `check()` calls this too, on the bucket named in the RECEIPT rather than an
# operator-typed flag -- a stale or hand-edited receipt naming a real bucket
# is exactly the half-awake, days-later mistake this guard exists to survive,
# and `check` only ever reads, so the mistake it prevents is pointing a
# credential's read at a bucket it should never have reached at all, days
# after the operator's attention was on something else.
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
        else:
            report = check(receipt_path=args.receipt, access_key=access_key, secret_key=secret_key)
    except (ProbeInputError, ObjectStorageError) as error:
        print(f"probe-media-lifecycle-expiration: {error}", file=sys.stderr)
        return 1

    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

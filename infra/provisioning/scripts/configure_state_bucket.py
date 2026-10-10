#!/usr/bin/env python3
"""Create one Pulumi state bucket, turn versioning on, set a noncurrent-version
expiry, and read both settings back from the provider. See
configure_state_bucket.md. Run by the owner with the bucket-admin key."""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import sys
import xml.etree.ElementTree as ET

import shared_objectstorage as so

S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/"
# The estate's erasure window: a state object removed here is gone from every
# copy within about 46 days (10 current + 1 for the daily pass + 35 noncurrent
# on the dump prefixes; see state_copy.md, "Retention"). A parameter, so a
# later ruling changes this value only.
NONCURRENT_EXPIRY_DAYS = 46


class StateBucketError(Exception):
    """Setup did not complete, or the provider's read-back disagrees."""


def versioning_document() -> bytes:
    return (f'<VersioningConfiguration xmlns="{S3_NS}"><Status>Enabled</Status>'
            "</VersioningConfiguration>").encode()


def lifecycle_document(noncurrent_days: int = NONCURRENT_EXPIRY_DAYS) -> bytes:
    if noncurrent_days < 1:
        raise StateBucketError("the noncurrent expiry must be at least one day")
    return (f'<LifecycleConfiguration xmlns="{S3_NS}"><Rule><ID>state-noncurrent-expiry</ID>'
            "<Status>Enabled</Status><Filter><Prefix></Prefix></Filter>"
            f"<NoncurrentVersionExpiration><NoncurrentDays>{noncurrent_days}</NoncurrentDays>"
            "</NoncurrentVersionExpiration></Rule></LifecycleConfiguration>").encode()


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_versioning(body: bytes) -> str | None:
    for el in ET.fromstring(body):
        if _local(el.tag) == "Status":
            return (el.text or "").strip()
    return None


def parse_noncurrent_days(body: bytes) -> list[int]:
    days = []
    for el in ET.fromstring(body).iter():
        if _local(el.tag) == "NoncurrentDays" and (el.text or "").strip().isdigit():
            days.append(int(el.text.strip()))
    return days


def configure(*, bucket, endpoint, region, access_key, secret_key,
              noncurrent_days=NONCURRENT_EXPIRY_DAYS, transport=so.urllib_request) -> dict:
    """Create (tolerating 'already owned by you'), enable versioning, set the
    lifecycle, then read both back. Raises StateBucketError unless the
    provider's answer shows both settings."""
    common = dict(endpoint=endpoint, region=region, access_key=access_key,
                  secret_key=secret_key, bucket=bucket, transport=transport)

    def call(method, query=None, payload=b"", extra=None, what=""):
        status, body = so.signed_request(method=method, query=query, payload=payload,
                                         extra_headers=extra, **common)
        return status, body

    status, body = call("PUT", what="create")
    if status not in (200, 409) or (status == 409 and b"BucketAlreadyOwnedByYou" not in body):
        raise StateBucketError(f"create bucket {bucket}: HTTP {status}")
    doc = versioning_document()
    status, _ = call("PUT", {"versioning": ""}, doc)
    if status // 100 != 2:
        raise StateBucketError(f"put versioning: HTTP {status}")
    life = lifecycle_document(noncurrent_days)
    md5 = base64.b64encode(hashlib.md5(life).digest()).decode()
    status, _ = call("PUT", {"lifecycle": ""}, life, {"content-md5": md5})
    if status // 100 != 2:
        raise StateBucketError(f"put lifecycle: HTTP {status}")
    status, body = call("GET", {"versioning": ""})
    got_versioning = parse_versioning(body) if status == 200 else None
    status, body = call("GET", {"lifecycle": ""})
    got_days = parse_noncurrent_days(body) if status == 200 else []
    if got_versioning != "Enabled":
        raise StateBucketError(f"read-back: versioning is {got_versioning!r}, not 'Enabled'")
    if got_days != [noncurrent_days]:
        raise StateBucketError(f"read-back: noncurrent expiry is {got_days!r}, not [{noncurrent_days}]")
    return {"bucket": bucket, "versioning": got_versioning, "noncurrent_days": got_days[0]}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bucket", required=True)
    p.add_argument("--endpoint", required=True)
    p.add_argument("--region", required=True)
    p.add_argument("--noncurrent-days", type=int, default=NONCURRENT_EXPIRY_DAYS)
    args = p.parse_args(argv)
    key, secret = os.environ.get("BUCKET_ADMIN_ACCESS_KEY_ID"), os.environ.get("BUCKET_ADMIN_SECRET_ACCESS_KEY")
    if not key or not secret:
        print("configure_state_bucket: BUCKET_ADMIN_ACCESS_KEY_ID and BUCKET_ADMIN_SECRET_ACCESS_KEY are required",
              file=sys.stderr)
        return 2
    try:
        print(configure(bucket=args.bucket, endpoint=args.endpoint, region=args.region, access_key=key,
                        secret_key=secret, noncurrent_days=args.noncurrent_days))
    except (StateBucketError, so.ObjectStorageError) as exc:
        print(f"configure_state_bucket: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""One-time setup of the backup bucket's versioning and lifecycle.

Run once by the platform owner, right after creating the bucket
(db/RUNBOOK-db.md's Rob-gated bucket step), from a workstation with the
bucket's S3 credential in the environment -- never from db1, and never by
either automated pipeline:

    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
      configure_backup_bucket.py --bucket branchleft-db-backups \\
      --endpoint hel1.your-objectstorage.com --region hel1

Object keys in this pipeline are already namespaced under MySQL's
`@@server_uuid` (dump_nightly.py, ship_binlogs.py), which is the primary
defence against a rebuilt db1 overwriting a pre-rebuild archive under a
reused name. Versioning is the second, independent layer required by doc 14
§8's own backup design: a bug in the namespacing, a manually re-run dump
under a hand-typed key, or any other write this pipeline did not anticipate
still lands as a new version rather than destroying the object it replaces.
The lifecycle rule bounds how long a *superseded* version survives --
`NoncurrentDays=35` comfortably outlives the 7-day on-host binlog retention
this stack otherwise relies on for recovery, without keeping every
overwritten version forever.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import sys

from objectstorage import ObjectStorageError, put_bucket_subresource

S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/"

# Comfortably beyond the 7-day on-host binlog window this stack otherwise
# depends on, without an unbounded lifetime for a version this pipeline no
# longer needs current.
NONCURRENT_VERSION_EXPIRATION_DAYS = 35


class BucketConfigError(Exception):
    """Setup did not complete."""


def versioning_document() -> bytes:
    return f'<VersioningConfiguration xmlns="{S3_NS}"><Status>Enabled</Status></VersioningConfiguration>'.encode()


def lifecycle_document(noncurrent_days: int = NONCURRENT_VERSION_EXPIRATION_DAYS) -> bytes:
    return (
        f'<LifecycleConfiguration xmlns="{S3_NS}">'
        "<Rule><ID>branchleft-db-backups-noncurrent-expiry</ID><Status>Enabled</Status>"
        "<Filter><Prefix></Prefix></Filter>"
        f"<NoncurrentVersionExpiration><NoncurrentDays>{noncurrent_days}</NoncurrentDays>"
        "</NoncurrentVersionExpiration>"
        "</Rule></LifecycleConfiguration>"
    ).encode()


def configure_backup_bucket(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    noncurrent_days: int = NONCURRENT_VERSION_EXPIRATION_DAYS,
    put=put_bucket_subresource,
) -> None:
    put(
        bucket=bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        subresource="versioning",
        body=versioning_document(),
    )

    lifecycle_body = lifecycle_document(noncurrent_days)
    content_md5 = base64.b64encode(hashlib.md5(lifecycle_body, usedforsecurity=False).digest()).decode()
    put(
        bucket=bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        subresource="lifecycle",
        body=lifecycle_body,
        content_md5=content_md5,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True, help="e.g. hel1.your-objectstorage.com")
    parser.add_argument("--region", required=True, help="the bucket's own location, e.g. hel1")
    parser.add_argument("--noncurrent-days", type=int, default=NONCURRENT_VERSION_EXPIRATION_DAYS)
    args = parser.parse_args(argv)

    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        print("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set.", file=sys.stderr)
        return 2

    try:
        configure_backup_bucket(
            bucket=args.bucket,
            endpoint=args.endpoint,
            region=args.region,
            access_key=access_key,
            secret_key=secret_key,
            noncurrent_days=args.noncurrent_days,
        )
    except ObjectStorageError as exc:
        print(f"configure_backup_bucket: {exc}", file=sys.stderr)
        return 1

    print(f"configure_backup_bucket: versioning enabled, {args.noncurrent_days}-day noncurrent expiry set on {args.bucket}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

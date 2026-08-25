#!/usr/bin/env python3
"""One-time setup of the backup bucket's versioning, lifecycle and fence.

Run once by the platform owner, right after creating the bucket
(db/RUNBOOK-db.md's owner-only bucket step), from a workstation with the
**operator's** S3 credential in the environment -- never db1's backup
credential, never from db1, and never by either automated pipeline:

    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
      configure_backup_bucket.py --bucket branchleft-db-backups \\
      --endpoint hel1.your-objectstorage.com --region hel1 \\
      --policy-file /tmp/branchleft-db-backups-policy.json

The policy is not optional and there is no flag to skip it. Hetzner's
documented default is that every key pair in a project is valid for every
bucket in that project, so a bucket configured without one is readable and
deletable by every credential in its project -- including keys minted for
something else entirely, and keys that sit in CI. A bucket fenced later than
it is created has a window; a bucket that can be configured without being
fenced grows a second unfenced bucket the next time someone adds one. Render
the document with `infra/provisioning/scripts/render-bucket-fence-policy.py`
and see RUNBOOK-bucket-fencing.md for the ordering and the live verification.

The credential in the environment must be the operator's because the fence
withholds every bucket-configuration action from db1's backup key: after this
runs, that key can no longer set versioning or lifecycle, which is the point.

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
import json
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


def _statement_resources(statement: dict) -> list[str]:
    resource = statement.get("Resource", [])
    return [resource] if isinstance(resource, str) else list(resource)


def _principals(statement: dict, field: str) -> list[str]:
    principal = statement.get(field)
    if not isinstance(principal, dict):
        return []
    aws = principal.get("AWS", [])
    return [aws] if isinstance(aws, str) else list(aws)


def assert_policy_fences_this_bucket(policy: dict, bucket: str, access_key: str) -> None:
    """Refuse a policy that names another bucket, or locks out the caller.

    Applying a bucket policy is the one operation here that can be
    irreversible. Every `Deny` in the policy governs the very API call that
    would edit it, so a `Deny` covering the credential in this environment
    leaves nobody able to replace or remove the statement doing the denying --
    not another key in the project, which the same statement also denies, and
    not `DeleteBucket`, which it denies too. Recovery is a support request
    against the storage cluster, with the bucket unreachable meanwhile.

    `render-bucket-fence-policy.py` checks the same invariant from the other
    direction, by evaluating the policy it just built. This check is structural
    and runs against the key actually in the environment, so it also catches
    the case that one cannot see: a correct policy for the right bucket,
    applied by the wrong credential. Two independent checks of one invariant is
    the intent.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    caller_suffix = f":{access_key}"

    for statement in policy.get("Statement", []):
        for resource in _statement_resources(statement):
            if resource != bucket_arn and not resource.startswith(f"{bucket_arn}/"):
                raise BucketConfigError(
                    f"the policy names resource {resource!r}, which is not {bucket!r}. "
                    f"Applying it here would fence the wrong bucket and leave this one open."
                )

        if statement.get("Effect") != "Deny":
            continue
        if not any(
            resource == bucket_arn for resource in _statement_resources(statement)
        ):
            continue

        not_principals = _principals(statement, "NotPrincipal")
        if not_principals:
            if not any(arn.endswith(caller_suffix) for arn in not_principals):
                raise BucketConfigError(
                    f"policy statement {statement.get('Sid', '<no Sid>')!r} denies bucket "
                    f"actions to every principal except "
                    f"{', '.join(not_principals)}, and the credential in this environment "
                    f"is not among them. Applying it would lock this bucket permanently. "
                    f"Run this as the operator whose access key the policy exempts."
                )
            continue

        principals = _principals(statement, "Principal")
        if any(arn == "*" or arn.endswith(caller_suffix) for arn in principals):
            raise BucketConfigError(
                f"policy statement {statement.get('Sid', '<no Sid>')!r} denies bucket actions "
                f"to the credential in this environment. Applying it would lock this bucket "
                f"permanently."
            )


def load_policy(path: str) -> tuple[dict, bytes]:
    with open(path, "rb") as handle:
        body = handle.read()
    try:
        policy = json.loads(body)
    except json.JSONDecodeError as error:
        raise BucketConfigError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(policy, dict) or not policy.get("Statement"):
        raise BucketConfigError(f"{path} carries no policy statements")
    return policy, body


def configure_backup_bucket(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    policy_body: bytes,
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

    # The fence goes on LAST. It denies every bucket-configuration action to
    # every key but the operator's, so the two calls above must already have
    # landed rather than depend on that exemption holding. No `content_md5`:
    # `aws s3api put-bucket-policy` sends none either, and a header this
    # endpoint does not expect is one more thing that can be rejected on the
    # one call that must not fail halfway.
    put(
        bucket=bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        subresource="policy",
        body=policy_body,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True, help="e.g. hel1.your-objectstorage.com")
    parser.add_argument("--region", required=True, help="the bucket's own location, e.g. hel1")
    parser.add_argument("--noncurrent-days", type=int, default=NONCURRENT_VERSION_EXPIRATION_DAYS)
    parser.add_argument(
        "--policy-file",
        required=True,
        help="the fence policy, from infra/provisioning/scripts/render-bucket-fence-policy.py",
    )
    args = parser.parse_args(argv)

    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        print("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set.", file=sys.stderr)
        return 2

    try:
        policy, policy_body = load_policy(args.policy_file)
        assert_policy_fences_this_bucket(policy, args.bucket, access_key)
    except (BucketConfigError, OSError) as exc:
        print(f"configure_backup_bucket: {exc}", file=sys.stderr)
        return 2

    try:
        configure_backup_bucket(
            bucket=args.bucket,
            endpoint=args.endpoint,
            region=args.region,
            access_key=access_key,
            secret_key=secret_key,
            policy_body=policy_body,
            noncurrent_days=args.noncurrent_days,
        )
    except ObjectStorageError as exc:
        print(f"configure_backup_bucket: {exc}", file=sys.stderr)
        return 1

    print(
        f"configure_backup_bucket: versioning enabled, {args.noncurrent_days}-day noncurrent "
        f"expiry set, and the fence applied on {args.bucket}. The fence is not proven until "
        f"verify-bucket-fence.py passes -- run it now, from this terminal."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

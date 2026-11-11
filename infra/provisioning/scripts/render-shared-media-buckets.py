#!/usr/bin/env python3
"""Render the policy and the operator commands for the estate's three shared media buckets.

The shared buckets sit behind the signing gateway. Each key is alone in its own
Hetzner project; the buckets sit in the storage project. See
render-shared-media-buckets.md for why each statement is shaped as it is.

Location, bucket names and the four key identifiers are required arguments.
There is no default location.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import NamedTuple

from bucketpolicy import (
    BUCKET_CONFIGURATION_ACTIONS,
    MEDIA_PUBLIC_OBJECT_ACTIONS,
    PolicyInputError,
    assert_enforceable,
    key_principal,
    validate_bucket_name,
)

SHARED_BUCKET_COUNT = 3

# Hetzner locations are short lowercase names with an optional number, such as
# fsn1, nbg1, ash or hil. Any such name is accepted; none is a default.
LOCATION_PATTERN = re.compile(r"\A[a-z]{2,6}[0-9]{0,2}\Z")

NONCURRENT_VERSION_DAYS = 30
INCOMPLETE_UPLOAD_DAYS = 7

# The gateway's real key: put, the multipart calls, head and get. No delete,
# and no list (whether the gateway may list is still open; see the .md).
GATEWAY_OBJECT_ACTIONS = [
    "s3:PutObject",
    "s3:AbortMultipartUpload",
    "s3:ListMultipartUploadParts",
    "s3:GetObject",
]

# The backup reader: read and list, never write.
READER_OBJECT_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion"]
READER_BUCKET_ACTIONS = ["s3:ListBucket", "s3:ListBucketVersions"]

# The erasure key: list versions and delete versions.
ERASURE_BUCKET_ACTIONS = ["s3:ListBucketVersions"]
ERASURE_OBJECT_ACTIONS = ["s3:DeleteObject", "s3:DeleteObjectVersion"]

DELETE_ACTIONS = ["s3:DeleteObject", "s3:DeleteObjectVersion"]

# Every bucket read that enumerates keys. Only the reader, the erasure key and
# the operator may use them.
LISTING_ACTIONS = [
    "s3:ListBucket",
    "s3:ListBucketVersions",
    "s3:ListBucketMultipartUploads",
]

# Configuration actions, minus the listing reads, which DenyListingExcept...
# handles so that the reader and the erasure key keep them.
CONFIGURATION_ACTIONS = [
    a for a in BUCKET_CONFIGURATION_ACTIONS if a not in LISTING_ACTIONS
]


class Keys(NamedTuple):
    """The four principals, as full ARNs. Each is a key in its own project, except the operator's."""

    gateway: str
    reader: str
    erasure: str
    admin: str


def parse_key(text: str) -> str:
    """`PROJECT:ACCESS_KEY` into the principal ARN, refusing anything that would change which principal it names."""
    if text.count(":") != 1:
        raise PolicyInputError(
            f"key {text!r} must be written PROJECT:ACCESS_KEY, with one colon"
        )
    project, access_key = text.split(":")
    return key_principal(project, access_key)


def _project_of(principal: str) -> str:
    # arn:aws:iam:::user/p<project>:<key>
    return principal.split("/", 1)[1].split(":", 1)[0]


def make_keys(gateway: str, reader: str, erasure: str, admin: str) -> Keys:
    keys = Keys(
        gateway=parse_key(gateway),
        reader=parse_key(reader),
        erasure=parse_key(erasure),
        admin=parse_key(admin),
    )
    if len(set(keys)) != len(keys):
        raise PolicyInputError(
            "two of the four keys are the same credential. Each must be its own key: a shared "
            "key would hold the rights of the other role."
        )
    projects = [_project_of(p) for p in keys]
    if len(set(projects)) != len(projects):
        raise PolicyInputError(
            "two of the four keys sit in one Hetzner project. Object ownership is by project, so "
            "keys that share a project can read and rewrite each other's objects whatever the "
            "policy says. Each key needs a project of its own."
        )
    return keys


def location_endpoint(location: str) -> str:
    if not LOCATION_PATTERN.match(location):
        raise PolicyInputError(
            f"location {location!r} must be a Hetzner location name such as fsn1 or nbg1"
        )
    return f"https://{location}.your-objectstorage.com"


def check_bucket_names(buckets: list[str]) -> list[str]:
    if len(buckets) != SHARED_BUCKET_COUNT:
        raise PolicyInputError(
            f"give exactly {SHARED_BUCKET_COUNT} --bucket names; got {len(buckets)}"
        )
    if len(set(buckets)) != len(buckets):
        raise PolicyInputError("the --bucket names must be distinct")
    return [validate_bucket_name(b) for b in buckets]


def render_policy(bucket: str, keys: Keys) -> dict:
    """The whole access policy for one shared bucket."""
    validate_bucket_name(bucket)
    # Object actions match `<bucket>/*`; bucket actions match the bare bucket ARN.
    # Neither is written with a trailing `*` on the bucket name, which would also
    # match a sibling bucket whose name starts the same way.
    bucket_arn = f"arn:aws:s3:::{bucket}"
    objects_arn = f"arn:aws:s3:::{bucket}/*"

    return assert_enforceable(
        {
            "Version": "2012-10-17",
            "Id": bucket,
            "Statement": [
                {
                    "Sid": "PublicReadObjectsAndVersions",
                    "Effect": "Allow",
                    "Principal": {"AWS": "*"},
                    "Action": list(MEDIA_PUBLIC_OBJECT_ACTIONS),
                    "Resource": objects_arn,
                },
                {
                    # Explicit Allow for the gateway's real key. The key lives in its
                    # own project and reaches nothing until a statement names it.
                    "Sid": "GatewayPutAndReadObjects",
                    "Effect": "Allow",
                    "Principal": {"AWS": [keys.gateway]},
                    "Action": list(GATEWAY_OBJECT_ACTIONS),
                    "Resource": objects_arn,
                },
                {
                    "Sid": "ReaderReadsObjects",
                    "Effect": "Allow",
                    "Principal": {"AWS": [keys.reader]},
                    "Action": list(READER_OBJECT_ACTIONS),
                    "Resource": objects_arn,
                },
                {
                    "Sid": "ReaderListsBucket",
                    "Effect": "Allow",
                    "Principal": {"AWS": [keys.reader]},
                    "Action": list(READER_BUCKET_ACTIONS),
                    "Resource": bucket_arn,
                },
                {
                    "Sid": "ErasureListsVersions",
                    "Effect": "Allow",
                    "Principal": {"AWS": [keys.erasure]},
                    "Action": list(ERASURE_BUCKET_ACTIONS),
                    "Resource": bucket_arn,
                },
                {
                    "Sid": "ErasureDeletesVersions",
                    "Effect": "Allow",
                    "Principal": {"AWS": [keys.erasure]},
                    "Action": list(ERASURE_OBJECT_ACTIONS),
                    "Resource": objects_arn,
                },
                {
                    # Listing is denied explicitly to everyone else, including
                    # anonymous callers and the gateway. An explicit Deny is not
                    # overcome by a public bucket ACL; an implicit deny would be.
                    "Sid": "DenyListingExceptReaderErasureOperator",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [keys.reader, keys.erasure, keys.admin]},
                    "Action": list(LISTING_ACTIONS),
                    "Resource": bucket_arn,
                },
                {
                    "Sid": "DenyBucketConfigurationExceptOperator",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [keys.admin]},
                    "Action": list(CONFIGURATION_ACTIONS),
                    "Resource": bucket_arn,
                },
                {
                    "Sid": "DenyDeleteExceptErasureAndOperator",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [keys.erasure, keys.admin]},
                    "Action": list(DELETE_ACTIONS),
                    "Resource": objects_arn,
                },
            ],
        }
    )


COMMAND_NOTES = """\
Run as the operator, with the bucket-admin key in the environment. Each bucket
is created once; the policy and lifecycle are idempotent. The three access
keys are made in the owner's console session, not here.

`s3` is a shell function, not a variable: zsh does not word-split an
unquoted parameter expansion.

Read back every bucket at the end. Hetzner can accept a configuration and
store something different.
"""


def render_bucket_commands(
    bucket: str, location: str, endpoint: str, keys: Keys
) -> str:
    policy = json.dumps(render_policy(bucket, keys), indent=2)
    return f"""\
s3 create-bucket --bucket {bucket} --acl private \\
  --create-bucket-configuration LocationConstraint={location}

s3 put-bucket-versioning --bucket {bucket} \\
  --versioning-configuration Status=Enabled

cat > /tmp/{bucket}-lifecycle.json <<'LIFECYCLE'
{{
  "Rules": [
    {{
      "ID": "shared-media-retention",
      "Status": "Enabled",
      "Filter": {{"Prefix": ""}},
      "NoncurrentVersionExpiration": {{"NoncurrentDays": {NONCURRENT_VERSION_DAYS}}},
      "AbortIncompleteMultipartUpload": {{"DaysAfterInitiation": {INCOMPLETE_UPLOAD_DAYS}}}
    }}
  ]
}}
LIFECYCLE
s3 put-bucket-lifecycle-configuration --bucket {bucket} \\
  --lifecycle-configuration file:///tmp/{bucket}-lifecycle.json
rm /tmp/{bucket}-lifecycle.json

cat > /tmp/{bucket}-policy.json <<'POLICY'
{policy}
POLICY
s3 put-bucket-policy --bucket {bucket} --policy file:///tmp/{bucket}-policy.json
rm /tmp/{bucket}-policy.json

s3 get-bucket-versioning --bucket {bucket}
s3 get-bucket-lifecycle-configuration --bucket {bucket}
s3 get-bucket-policy --bucket {bucket} --output text
"""


def render_commands(buckets: list[str], location: str, keys: Keys) -> str:
    """The operator sequence for all three buckets, with every value filled in."""
    endpoint = location_endpoint(location)
    checked = check_bucket_names(buckets)
    header = f"""\
printf 'Access key id: '; read -r AWS_ACCESS_KEY_ID; export AWS_ACCESS_KEY_ID

printf 'Secret access key (hidden): '; read -rs AWS_SECRET_ACCESS_KEY; echo; export AWS_SECRET_ACCESS_KEY

export AWS_DEFAULT_REGION='{location}'
s3() {{ aws --endpoint-url {endpoint} s3api "$@"; }}
"""
    body = "\n".join(
        render_bucket_commands(b, location, endpoint, keys) for b in checked
    )
    return header + "\n" + body


def build_parser() -> argparse.ArgumentParser:
    # No default on any value: a missing location is a refusal.
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--location", required=True, help="Hetzner location every bucket is created in"
    )
    parser.add_argument(
        "--bucket",
        action="append",
        required=True,
        help="a shared bucket name; give exactly three",
    )
    parser.add_argument(
        "--gateway-key",
        required=True,
        help="PROJECT:ACCESS_KEY of the gateway's real key",
    )
    parser.add_argument(
        "--reader-key",
        required=True,
        help="PROJECT:ACCESS_KEY of the backup reader key",
    )
    parser.add_argument(
        "--erasure-key", required=True, help="PROJECT:ACCESS_KEY of the erasure key"
    )
    parser.add_argument(
        "--admin-key", required=True, help="PROJECT:ACCESS_KEY of the bucket-admin key"
    )
    parser.add_argument(
        "--commands",
        action="store_true",
        help="print the operator command sequence instead of the policies",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        keys = make_keys(
            args.gateway_key, args.reader_key, args.erasure_key, args.admin_key
        )
        if args.commands:
            print(COMMAND_NOTES, file=sys.stderr)
            print(render_commands(args.bucket, args.location, keys), end="")
        else:
            checked = check_bucket_names(args.bucket)
            location_endpoint(args.location)
            print(json.dumps({b: render_policy(b, keys) for b in checked}, indent=2))
    except PolicyInputError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

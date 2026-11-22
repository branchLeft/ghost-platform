#!/usr/bin/env python3
"""Refuse a tenant state backend that is not the gateway's, and render the URL.

Reads the state bucket, the region, the tenant's opaque state prefix and the
tenant's name from the environment, checks each, and appends
`TENANT_BACKEND_URL` and `AWS_REGION` to the file named by `$GITHUB_ENV`.
Nothing is printed on success, and no value is ever printed on failure: the
failure names the field. See render-tenant-state-backend.md#module-overview.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping

# The public name of the storage gateway's state instance. Every tenant's
# state backend goes through it, so no tenant holds a key to the object store.
STATE_GATEWAY_ENDPOINT = "https://state.branchleft.co.uk"

# The estate's own state bucket. Its checkpoint carries the production cloud
# token, so no tenant state, and no tenant credential, may ever name it.
ESTATE_STATE_BUCKET = "branchleft-pulumi-state"

_BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_REGION = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
# A random identifier: long, lower-case, one path segment.
_PREFIX = re.compile(r"^[a-z0-9][a-z0-9-]{23,63}$")


def problems(
    bucket: str, region: str, prefix: str, tenant: str, repo_name: str
) -> list[str]:
    """The names of the fields that are unusable; empty means usable. Never a value."""
    bad: list[str] = []
    if not _BUCKET.fullmatch(bucket) or bucket == ESTATE_STATE_BUCKET:
        bad.append("STATE_GATEWAY_BUCKET")
    if not _REGION.fullmatch(region):
        bad.append("STATE_GATEWAY_REGION")
    if not _PREFIX.fullmatch(prefix) or _names_the_tenant(prefix, tenant, repo_name):
        bad.append("state_prefix")
    return bad


def _names_the_tenant(prefix: str, *names: str) -> bool:
    """A prefix that is, or contains, the tenant's name was not drawn at random."""
    lowered = prefix.lower()
    return any(len(n) >= 3 and n.lower() in lowered for n in names)


def render(bucket: str, region: str, prefix: str) -> str:
    return (
        f"s3://{bucket}/{prefix}"
        f"?endpoint={STATE_GATEWAY_ENDPOINT}&s3ForcePathStyle=true&region={region}"
    )


def main(env: Mapping[str, str], github_env_path: str | None) -> int:
    bucket = env.get("STATE_GATEWAY_BUCKET", "")
    region = env.get("STATE_GATEWAY_REGION", "")
    prefix = env.get("TENANT_STATE_PREFIX", "")
    bad = problems(bucket, region, prefix, env.get("TENANT", ""), env.get("TENANT_REPO_NAME", ""))
    if bad:
        print(
            "::error::the tenant state backend cannot be built: these are empty, "
            f"malformed or unsafe: {', '.join(bad)}. STATE_GATEWAY_BUCKET and "
            "STATE_GATEWAY_REGION are repository variables; state_prefix is the "
            "tenant's opaque prefix from the tenant register, never the slug, and "
            "the bucket is never the estate's own.",
            file=sys.stderr,
        )
        return 1
    if not github_env_path:
        print("::error::GITHUB_ENV is not set; there is nowhere to hand the backend URL to.", file=sys.stderr)
        return 1
    with open(github_env_path, "a", encoding="utf-8") as handle:
        handle.write(f"TENANT_BACKEND_URL={render(bucket, region, prefix)}\n")
        handle.write(f"AWS_REGION={region}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(os.environ, os.environ.get("GITHUB_ENV")))

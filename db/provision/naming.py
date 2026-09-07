#!/usr/bin/env python3
"""Every name this stack derives from a tenant name, in one place.

The charset rule mirrors `infra/tenant/naming.ts`'s `validateTenantSlug`,
reused rather than re-derived -- kept identical deliberately, because the same
string becomes a MySQL account name here and a systemd instance name there,
and a name valid on one side and not the other produces a tenant that
half-exists. The length limit does not mirror it: `infra/tenant/naming.ts`'s
26-character bound and this module's are both derived from MySQL's own
32-character account-name limit independently, so they agree by
construction rather than by copying a number.

The trailing character is restricted to a letter or digit for the same reason
it is on the TypeScript side: `infra/tenant/media.ts`'s `mediaBucketName`
turns this same slug into an S3-compatible bucket name, and S3 bucket naming
rules require a bucket name to both start and end with a lowercase letter or
digit.

MySQL's own account name limit -- 32 characters, unchanged since 5.7.8 and
confirmed current in the MySQL 8.0 reference manual
(https://dev.mysql.com/doc/refman/8.0/en/user-names.html) -- applies to
`TENANT_DB_PREFIX + tenant_name`, since that combined string is both the
database name and the account name this stack creates.
"""

from __future__ import annotations

import re

TENANT_DB_PREFIX = "ghost_"

MAX_MYSQL_ACCOUNT_NAME_LENGTH = 32

MAX_TENANT_NAME_LENGTH = MAX_MYSQL_ACCOUNT_NAME_LENGTH - len(TENANT_DB_PREFIX)

TENANT_NAME_PATTERN = re.compile(r"\A[a-z]([a-z0-9-]*[a-z0-9])?\Z")

# The tenant's dedicated DB user only ever connects from the app hosts, over
# the private subnet -- scoping the account's host part to it is a second,
# independent boundary alongside `require_secure_transport`.
TENANT_USER_HOST = "10.20.1.%"


class InvalidTenantName(ValueError):
    """Raised for a tenant name this stack refuses to provision from."""


def validate_tenant_name(tenant_name: str) -> None:
    if not TENANT_NAME_PATTERN.match(tenant_name):
        raise InvalidTenantName(
            f"tenant name {tenant_name!r} must start with a lowercase letter, end with a "
            "lowercase letter or digit, and contain only lowercase letters, digits and "
            "hyphens in between"
        )
    if len(tenant_name) > MAX_TENANT_NAME_LENGTH:
        raise InvalidTenantName(
            f"tenant name {tenant_name!r} is {len(tenant_name)} characters; must be at "
            f"most {MAX_TENANT_NAME_LENGTH} so \"{TENANT_DB_PREFIX}\" plus the name fits "
            f"MySQL's {MAX_MYSQL_ACCOUNT_NAME_LENGTH}-character account name limit"
        )


def sql_identifier(tenant_name: str) -> str:
    """MySQL identifiers cannot carry the hyphens a tenant name may."""
    return tenant_name.replace("-", "_")


def database_and_user_name(sql_id: str) -> str:
    """The tenant's logical database and its dedicated DB user share this name."""
    return f"{TENANT_DB_PREFIX}{sql_id}"

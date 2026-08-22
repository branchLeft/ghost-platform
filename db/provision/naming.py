#!/usr/bin/env python3
"""Every name this stack derives from a tenant name, in one place.

The charset rule mirrors `infra/tenant/naming.ts`'s `validateTenantName` (the
GCP-era tenant component), reused rather than re-derived. The length limit
does not: that one is 30 chars minus a GCP service-account prefix, which has
no bearing on a self-managed MySQL host. The binding constraint here is
MySQL's own account name limit -- 32 characters, unchanged since 5.7.8 and
confirmed current in the MySQL 8.0 reference manual
(https://dev.mysql.com/doc/refman/8.0/en/user-names.html) -- applied to
`TENANT_DB_PREFIX + tenant_name`, since that combined string is both the
database name and the account name this stack creates.
"""

from __future__ import annotations

import re

TENANT_DB_PREFIX = "ghost_"

MAX_MYSQL_ACCOUNT_NAME_LENGTH = 32

MAX_TENANT_NAME_LENGTH = MAX_MYSQL_ACCOUNT_NAME_LENGTH - len(TENANT_DB_PREFIX)

TENANT_NAME_PATTERN = re.compile(r"\A[a-z][a-z0-9-]*\Z")

# The tenant's dedicated DB user only ever connects from the app hosts, over
# the private subnet -- scoping the account's host part to it is a second,
# independent boundary alongside `require_secure_transport`.
TENANT_USER_HOST = "10.20.1.%"


class InvalidTenantName(ValueError):
    """Raised for a tenant name this stack refuses to provision from."""


def validate_tenant_name(tenant_name: str) -> None:
    if not TENANT_NAME_PATTERN.match(tenant_name):
        raise InvalidTenantName(
            f"tenant name {tenant_name!r} must start with a lowercase letter and contain "
            "only lowercase letters, digits and hyphens"
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

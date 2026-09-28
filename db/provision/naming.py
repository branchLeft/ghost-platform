#!/usr/bin/env python3
"""Every name this stack derives from a tenant name, in one place.

The charset rule mirrors infra/tenant/naming.ts's validateTenantSlug
exactly, since the same string becomes a MySQL account name here and a
systemd instance name there. The length limit is independently derived
from MySQL's 32-character account-name limit rather than copied.
See naming.md for the full reasoning.
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

# No reserved-name guard here, deliberately: `scripts/assert-slug-pattern-
# consistency.py` records the decision explicitly (it excludes this module
# from its cross-copy reserved-name comparison for the same reason) --
# `infra/tenant`'s `GhostTenant` component already refuses a reserved slug
# during `pulumi up`, before DB provisioning against that slug is ever run,
# so this module was never given a second copy of that check. Adding one
# would not tighten anything upstream of it and would be a fifth place for
# the reserved set to drift.


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

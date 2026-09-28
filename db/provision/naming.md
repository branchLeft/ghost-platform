# naming.py

## Overview

Every name this stack derives from a tenant name, in one place.

The charset rule mirrors `infra/tenant/naming.ts`'s `validateTenantSlug`,
reused rather than re-derived -- kept identical deliberately, because the
same string becomes a MySQL account name here and a systemd instance name
there, and a name valid on one side and not the other produces a tenant
that half-exists. The length limit does not mirror it:
`infra/tenant/naming.ts`'s 26-character bound and this module's are both
derived from MySQL's own 32-character account-name limit independently, so
they agree by construction rather than by copying a number.

The trailing character is restricted to a letter or digit for the same
reason it is on the TypeScript side: `infra/tenant/media.ts`'s
`mediaBucketName` turns this same slug into an S3-compatible bucket name,
and S3 bucket naming rules require a bucket name to both start and end
with a lowercase letter or digit.

MySQL's own account name limit -- 32 characters, unchanged since 5.7.8 and
current in the MySQL 8.0 reference manual -- applies to
`TENANT_DB_PREFIX + tenant_name`, since that combined string is both the
database name and the account name this stack creates.

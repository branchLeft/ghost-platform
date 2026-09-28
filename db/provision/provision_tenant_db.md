# provision_tenant_db.py

## Overview

Idempotent create of one tenant's database, dedicated user and grants.

Run by hand on db1 itself (as root, once per tenant onboarded):

```sh
MYSQL_PWD=... provision_tenant_db.py --admin-user root blog
```

Connects over the Unix socket, never TCP: `root` only ever exists as
`'root'@'localhost'` (the official mysql image's own default -- nothing
here adds a `MYSQL_ROOT_HOST`), which the client library only reaches via a
socket. Widening root to a TCP-reachable host purely so this script could
use it would be a strictly worse trade for the one script that already
runs locally. `MYSQL_PWD` -- never an argument, which would land in shell
history and the process table -- still applies over a socket connection
exactly as it would over TCP.

Re-running against an existing tenant changes nothing about its password:
`CREATE USER IF NOT EXISTS` is a no-op when the account already exists, so
this is safe to run again to reapply a raised `MAX_USER_CONNECTIONS` or to
confirm a tenant's grants without touching a credential something else
already depends on.

Self-managed MySQL is what makes this one script rather than two: an
earlier component could create the database and user but had no
privileged credential able to set `MAX_USER_CONNECTIONS`, so a platform
admin ran that ALTER by hand against the managed database afterwards. Here
the same credential that creates the account can cap it in the same
statement batch.

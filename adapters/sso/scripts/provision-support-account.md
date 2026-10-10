# provision-support-account.mjs

## Overview

Ghost's normal route to a new staff account is an emailed invite, and a
tenant with no working mail yet cannot complete one. This writes the row
directly into the tenant's own Ghost database instead, through the tenant's
already-running container, using whichever DB driver Ghost itself has
installed — never a driver of this script's own, and never a credential this
script reads itself: connection details come from the container's own
environment, exactly as `render-core` rendered them.

Usage:

```sh
node provision-support-account.mjs --container <name> --email <address>
```

Idempotent: a second run against the same container is a no-op when the row
is already complete AND still suspended — it never re-suspends an account a
tenant has since granted, and never mints a second unusable password for the
same email. A row missing its Administrator link (a partial write) is
repaired, never silently skipped — see `administratorRoleLinkFor` in the
inner script. An already-complete row that is NOT suspended is refused
loudly (`ActiveExistingRowError`), never reported as a successful no-op: the
support account must stay suspended at rest, and the one moment there is no
tenant grant to protect is also the moment nothing here should mistake a
live grant for that resting state. The account this script CREATES is
ALWAYS suspended (Ghost's own `inactive` status); nothing here accepts a
flag to create one active.

The user row and its Administrator link are written inside one transaction
(a `knex.transaction`), for both database backends, so a
`docker exec` killed mid-write leaves either both rows or neither — never
the partial state the repair path exists to recover from on a row written
before this fix, or by anything else. The repair path's own read-then-decide
is inside that same transaction too (on MySQL the row is read `forUpdate()`,
which locks it; SQLite has no row lock, and this script only ever runs one
`docker exec` at a time against a given container, so the transaction's own
write serialisation is enough there), closing the window between the check
and the grant.

The connection is Ghost's own, so it carries every `database__connection__*`
setting Ghost itself uses, TLS included — db1 refuses a plaintext TCP
connection outright (`require_secure_transport=ON`), so a script that
ignored them could never reach a paying tenant's real database.

## Inner script

The inline script run *inside* the tenant's own container. It never runs as a
`node -e` invocation from this session's own shell — only as an argument
this script hands to `docker exec` at run time, from inside an
already-vetted file.

It queries through Ghost's own knex, the query builder Ghost's models use,
not raw SQL: it requires Ghost's `core/server/data/db/connection.js` from the
installed release (`/var/lib/ghost/current`), which builds the knex instance
from Ghost's own config exactly as the running Ghost does. That config is
loaded from the container's environment (`database__*`, JSON-parsed as Ghost
parses it) and from `config.production.json` in the working directory, which
`docker exec` inherits from the image (`/var/lib/ghost`). So the script
connects with whatever Ghost connects with — the `sqlite3` alias to
`better-sqlite3`, SQLite's `foreign_keys = ON`, every
`database__connection__ssl__*` key — and this repo takes no database
dependency of its own.

`EMAIL`/`ID`/`PASSWORD_HASH`/`NOW` arrive as env vars on the `docker exec`
call, never interpolated into the script text itself — the same reason
`render-core`'s own shell-quoting exists: a value is data, never syntax.

Ghost's own modules may log to stdout while the connection opens. The outer
script reads only the last line of the inner script's output, which is always
its JSON result.

## provisionSupportAccount

Creates the suspended support account inside `container`'s own Ghost
database, atomically; repairs a pre-existing row missing its Administrator
link; or reports a pre-existing, already-complete SUSPENDED row untouched.
Always inserts as `inactive` — see Overview above for why there is no way to
ask for anything else. A pre-existing, already-complete row that is NOT
suspended throws `ActiveExistingRowError` rather than being reported as
success — see that class's own doc comment. Returns
`{created, repaired, id, status}`: `created` and `repaired` are never both
true.

## provisionSupportAccountViaEngine

The same provisioning for a caller that has no `docker` CLI: the grant tool,
which runs in a container with only the Engine socket. It takes a client with
`exec({ container, cmd, env })` (`docker-engine.mjs`) and runs the same inner
script with the same env and the same two named refusals. Nothing about the
account changes: the row is always created suspended.

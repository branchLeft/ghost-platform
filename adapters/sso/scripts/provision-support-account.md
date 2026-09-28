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
(`inTransaction` in the inner script), for both database backends, so a
`docker exec` killed mid-write leaves either both rows or neither — never
the partial state the repair path exists to recover from on a row written
before this fix, or by anything else. The repair path's own read-then-decide
is inside that same transaction too (MySQL locks the row with `for update`),
closing the window between the check and the grant.

The MySQL connection carries the same `database__connection__ssl__*` keys
`render-core` renders for Ghost itself — db1 refuses a plaintext TCP
connection outright (`require_secure_transport=ON`), so a script that
ignored them could never reach a paying tenant's real database.

## Inner script

The inline script run *inside* the tenant's own container, exactly the
pattern `break-glass.image.test.mjs`'s own `sql()`/`createSupportUser`
helpers already use to reach Ghost's own installed database driver without
this repo taking a dependency of its own on either one. It never runs as a
`node -e` invocation from this session's own shell — only as an argument
this script hands to `docker exec` at run time, from inside an
already-vetted file.

`EMAIL`/`ID`/`PASSWORD_HASH`/`NOW` arrive as env vars on the `docker exec`
call, never interpolated into the script text itself — the same reason
`render-core`'s own shell-quoting exists: a value is data, never syntax.

### TLS options from the container's environment

db1 sets `require_secure_transport=ON` (`db/stack/conf.d/branchleft.cnf`), so
a plaintext `connect()` to a paying tenant's real database is refused
outright. `render-core` renders the same `database__connection__ssl__*` keys
Ghost's own config reads (today just
`database__connection__ssl__rejectUnauthorized`). The inner script reads
whichever of those keys the container actually has, rather than hard-coding
the one key `render-core` renders today, so a key added on either side does
not need this script updated in step.

Ghost's own env parser JSON-parses each value where it can
(`render-core/src/validate.ts`'s `assertNotJsonScalar`): the env string
`"false"` arrives as the boolean `false`, not the string `"false"`. mysql2
negotiates TLS only when `config.ssl` is set at all (mysql2/promise's
`client_handshake.js`: `if (connection.config.ssl)`), so passing the raw
string through would make even `ssl: {rejectUnauthorized: "false"}` (a truthy
object) request no certificate validation while still enabling TLS. That
happens to be harmless here, but mirroring the real coercion means the script
never quietly drifts from what Ghost itself does with the same key.

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

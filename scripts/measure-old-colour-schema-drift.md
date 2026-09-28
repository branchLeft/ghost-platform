# measure-old-colour-schema-drift.sh

## What this measures

Measures whether a drained old colour keeps serving correctly once its
paired new colour has migrated the shared database forward across the
real first minor-bump range (`ghost:6.55.0-alpine` -> `ghost:6-alpine`, the
newest 6.x minor Docker Hub resolves to at run time).

Mirrors an earlier spike's approach: one database, two real Ghost
containers, blue never restarted. This adds what that spike did not test
-- a green that actually runs contracting migrations while blue keeps
serving -- and runs the smoke suite Done means names (owner session,
publish, render, member sign-in) against blue both before and after
green's migration, on a real engine.

Usage:

```bash
./scripts/measure-old-colour-schema-drift.sh mysql
./scripts/measure-old-colour-schema-drift.sh sqlite
```

Requires: docker, curl, host `mysql` and `sqlite3` clients (used to
inspect/reproduce against the real migrated schema directly, never to
fabricate a result). Cleans up every container, network and temp dir it
creates, even on failure.

## run_smoke reuses the session

`run_smoke` does owner setup+session, publish, render (with an
absent-marker control), member creation and a magic-link request. On
"before" this creates the owner and logs in fresh. On "after" it
deliberately does NOT log in again -- it reuses the cookie jar "before"
already populated, because the real scenario is an admin whose browser
session has been open the whole time blue kept serving, never a fresh
re-authentication.

A fresh `/session/` POST minutes into the run hits Ghost's own
login-verification 2FA-by-email gate on the second explicit login. That
was confirmed by running it that way first: the failure was `ESOCKET` on
the auth-code email, not a schema error, and it obscured the actual
measurement. Re-using the live session avoids re-triggering that
unrelated control.

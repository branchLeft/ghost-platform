# environment.ts

## The environment one tenant's Ghost container receives

Two destinations, and the split is a security boundary rather than a
convenience:

- The **Compose file** is committed to the tenant's repo and rendered into
  `/opt/branchleft/<slug>/compose.yml`. Every non-secret value is inline
  there, so what a tenant is configured with is reviewable in a diff.
- **`/etc/branchleft/<slug>.env`** is root-owned `0600` on the app host,
  holds only secrets, and is written by an operator — never by an automated
  path. The Compose file references those values as `${VAR:?…}`, so a
  missing secret fails the stack's start rather than booting Ghost with an
  empty password.

Values are read by Ghost through nconf's `__`-separated env mapping with
`parseValues: true` (`ghost/core/core/shared/config/loader.ts`), so
`'false'` arrives as a boolean and a numeric string as a number. That is
why the booleans and byte counts below are written as their literal JSON
forms rather than as strings Ghost would have to coerce.

# Portal data layer

The portal's storage over PostgreSQL (`ghost-platform-docs/19-try-it-now-design/08-portal.html`
sections 01, 10 and 10b). It holds no comment text and no member content.

## The guarantee

A tenant-facing query with no tenant bound fails; the same query with tenant A
bound returns only A's rows.

- `TenantDb.run(scope, work)` takes a `TenantScope`. The only way to make one is
  `bindTenant(id)` with the id from the signed-in session, so a call without a
  binding does not compile.
- Every statement then runs as the `portal_tenant` role with the tenant bound in
  the transaction (`portal.tenant_id`). Row-level security on every tenant table
  filters by `portal.bound_tenant()`, which raises when nothing is bound.
- A new tenant-facing table has a `tenant_id uuid` column and one call to
  `portal.isolate_table(...)` in its migration. `migrate()` refuses a schema
  where a table has the column and lacks the policy.
- `bindTenantFromOrganisation` resolves a Zitadel organisation to a scope. It is
  the one statement that runs before a tenant is bound, through a function that
  answers only for the organisation it is given.

## The owner path

`portal/data` exports `./tenant` and `./owner` separately. Tenant-facing code
imports the first only; a test fails if anything under `src/tenant` imports the
owner path or the migrator. The owner pool connects as a login that is a member
of `portal_owner` alone, so the tenant-facing connection cannot assume that role.

## Running the tests

```sh
nvm use && npm ci
PORTAL_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/postgres npm run coverage
```

The URL must be a superuser on a throwaway cluster (CI uses a service
container). The suite creates and drops its own databases.

## Roles

The migration creates `portal_tenant` and `portal_owner` as `NOLOGIN` roles. The
deployment grants each to its own login role; no credential lives here.

# Portal data layer

The portal's storage over PostgreSQL (`ghost-platform-docs/19-try-it-now-design/08-portal.html`
sections 01, 10 and 10b). It holds no comment text and no member content.

## The guarantee

A tenant-facing query with no tenant bound fails; the same query with tenant A
bound returns only A's rows.

- `TenantDb.run(scope, work)` takes a `TenantScope`. The only way to make one is
  `bindTenant(id)` with the id from the signed-in session, so a call without a
  binding does not compile.
- Every statement then runs in a transaction as the `portal_tenant` role with
  the tenant bound (`portal.tenant_id`). Row-level security on every tenant
  table filters by `public.bound_tenant()`, which raises when nothing is bound.
- All access is Drizzle. The schema (`src/schema.ts`) declares the policies and
  `drizzle/` holds the generated migrations. A schema module is checked by
  `assertTenantTablesIsolated`: a table with a `tenant_id` column and no row
  security or no `tenant_isolation` policy is refused.
- `TenantDb.scopeForOrganisation` resolves a Zitadel organisation to a scope. It
  binds the organisation (`portal.organisation_id`) instead of a tenant, and a
  second policy lets that binding read the one register row for that
  organisation, nothing else.

### Raw SQL

Exactly three things are not expressed through Drizzle (`DB-2` approval, owner
ruling): the role switch (`SET LOCAL ROLE`, `enterRole` in `src/db.ts`), the
binding call (`set_config`, `bind` in `src/db.ts`), and the binding functions
(`drizzle/0000_binding_functions.sql`, called from the policy predicates in
`src/schema.ts`). `provision/` holds the operator's role and grant statements,
which Drizzle cannot model.

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
container). The suite creates and drops its own databases. After a schema edit,
`npm run generate` writes the migration; CI fails if the committed one differs.

## Provisioning a database

In order: `createRoles`, the ORM's migrations (`migrateSchema`), then
`grantAccess` for each table and `grantRole` for each login (`provision/`). The
roles are `NOLOGIN`; no credential lives here.

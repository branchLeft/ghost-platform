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

### Policies

`public.bound_tenant()` raises when neither a tenant nor an organisation is
bound, so an unbound statement fails instead of returning nothing or
everything. When only an organisation is bound it returns null: no tenant row
matches, and the `organisation_lookup` policy exposes just that organisation's
register row, which is how a session's organisation becomes a bound tenant.

### Raw SQL

Exactly three things are not expressed through Drizzle (`DB-2` approval, owner
ruling): the role switch (`SET LOCAL ROLE`, `enterRole` in `src/db.ts`), the
binding call (`set_config`, `bind` in `src/db.ts`), and the binding functions
(`drizzle/0000_binding_functions.sql`, called from the policy predicates in
`src/schema.ts`). `src/provision.ts` holds the operator's role and grant statements,
which Drizzle cannot model.

## Health and version readings

`portal.health_reading` holds one row per tenant: the latest health, the Ghost
version the instance reports, whether that matches the descriptor's intended
version, and `mismatch_since`, the first reading of a continuing mismatch. It is
isolated like every tenant table: a tenant reads its own row (`TenantDb.ownHealth`)
and cannot write; the owner role writes and reads all rows.

The source is the drain sidecar's `GET /metrics`, scraped per colour by a
collector that dials in. `OwnerDb.recordReading(tenantId, scrapes, observedAt)`
takes the colours' scrape texts. Only the undrained colour answers: its version
and match are the tenant's, a drained colour's are never read, and with no
scrape, no undrained colour or two the reading is `unknown` (`src/reading.ts`).
`OwnerDb.listHealth()` is the console's cross-tenant read. The collector that
fetches the scrapes is separate work; grant `portal.health_reading` with
`grantAccess` (tenant `SELECT`, owner `SELECT, INSERT, UPDATE, DELETE`).

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

One command, run by the operator as a database administrator and never by the
portal. In the portal-apps image, from `/app/portal/data`:

```sh
node dist/provisionMain.js   # or: npm run provision
```

Every input is a file named by an environment variable; a secret in argv or in
the variable itself is refused.

| Variable | Holds |
| --- | --- |
| `PORTAL_ADMIN_URL_FILE` | administrator connection URL (host and user required) |
| `PORTAL_TENANT_PASSWORD_FILE` | password for the tenant login (printable ASCII) |
| `PORTAL_OWNER_PASSWORD_FILE` | password for the owner login (printable ASCII) |
| `PORTAL_DATABASE_NAME` | optional, default `portal` |
| `PORTAL_TENANT_LOGIN` | optional, default `portal_tenant_login` |
| `PORTAL_OWNER_LOGIN` | optional, default `portal_owner_login` |

In order: the database if absent, both logins (attributes and password
re-applied every run, sent as a SCRAM verifier), `CONNECT` on the database for
the two logins alone, no `CREATE` on `public`, the two roles, the ORM's
migrations, the per-table grants, exactly one role per login, then a check
that connects as each login and asserts the specific PostgreSQL errors
(`42501` permission denied, `28000` no tenant bound). A re-run changes nothing.
Other databases on the server keep PUBLIC's `CONNECT`: closing them to these
logins is a server-level step (`pg_hba.conf`), outside this command.

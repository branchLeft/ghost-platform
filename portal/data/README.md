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
`src/schema.ts`). `provision/` holds the operator's role and grant statements,
which Drizzle cannot model, and the catalog check that compares a server with
them.

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
fetches the scrapes is separate work. The grants on `portal.health_reading`
(tenant `SELECT`, owner `SELECT, INSERT, UPDATE`) are in the manifest,
`provision/manifest.ts`.

## Versioned documents and acceptance

`portal.document_version` holds the published versions of three documents
(`terms`, `usage`, `subprocessors`), shared by every tenant. A version is never
updated or deleted (no role holds the privilege), and it is in force once its
`effective_at` has passed: `TenantDb.currentDocument(scope, kind, now)` returns
the highest such version, so a version published but not yet effective is
stored and not shown as in force. For the sub-processor list the table itself
refuses an effective date earlier than `published_at` plus the notice period,
and a notice of under `SUBPROCESSOR_NOTICE_DAYS` (30, an owner ruling). `published_at` is the database's own clock (the
column default): `OwnerDb.publishDocument` takes no publication time from its
caller, so a call cannot backdate itself out of the notice.

During the notice a tenant is told, not surprised:
`TenantDb.upcomingSubprocessors(scope, now)` returns each announced list
version with its effective date and the entries it adds or drops against the
list in force, and the tenant portal shows it as upcoming (with an objection
text that is a placeholder), apart from the live list. An upcoming version is
in no current list and cannot be accepted.

`portal.document_acceptance` records which tenant accepted which version, by
whom and when. It is isolated like every tenant table and insert-only.
Acceptance belongs to a version, so a new version is pending again for a tenant
that accepted the last (`pendingAcceptances`, and `assertAccepted` as the
gate; its caller will be the step that turns a demo user into a paying tenant,
not built here). Only the version in force can be accepted. Text in this layer is
placeholder only; the real wording is supplied by the owner.

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

The URL must be a superuser on a throwaway cluster started with
`test/pg_hba.ci.conf` as its `hba_file` (writable by the server's user, since
the pg_hba tests rewrite and restore it), because the provisioning command
refuses any rule that lets a portal login reach another database. CI runs the
suite on PostgreSQL 14 and 17. The suite creates and drops its own databases.
After a schema edit, `npm run generate` writes the migration; CI fails if the
committed one differs.

## Provisioning a database

One command, run by the operator as a database administrator and never by the
portal. In the portal-apps image, from `/app/portal/data`:

```sh
node dist/provision/provisionMain.js   # or: npm run provision
```

Every input is a file named by an environment variable; a secret in argv or in
the variable itself is refused.

| Variable                      | Holds                                                 |
| ----------------------------- | ----------------------------------------------------- |
| `PORTAL_ADMIN_URL_FILE`       | administrator connection URL (host and user required) |
| `PORTAL_TENANT_PASSWORD_FILE` | password for the tenant login (printable ASCII)       |
| `PORTAL_OWNER_PASSWORD_FILE`  | password for the owner login (printable ASCII)        |
| `PORTAL_DATABASE_NAME`        | optional, default `portal`                            |
| `PORTAL_TENANT_LOGIN`         | optional, default `portal_tenant_login`               |
| `PORTAL_OWNER_LOGIN`          | optional, default `portal_owner_login`                |

The command creates what is absent, checks everything, and repairs nothing.
`provision/manifest.ts` is the closed manifest: the two roles and two logins
with their exact attributes (all `NOINHERIT`; the apps always `SET LOCAL
ROLE`), one membership per login, and every grant, each justified by a call
site. No role may `DELETE`, and the owner role may not `UPDATE` the register.

1. **Check, before any write.** The whole privilege state of the server is
   compared with the manifest through the closed list of mechanisms
   (`MECHANISMS`, M01 to M29, in `provision/catalog.ts`): role attributes and
   reach, settings, every ACL (counting implicit defaults), ownership,
   `pg_shdepend` across every database, policies, the shape of each manifest
   table, every catalog row created after initdb, ACL drift on initdb
   objects, the settings that switch checks off, and pg_hba (the rules as
   parsed, refusing on a rule that did not load or a file changed since the
   last load, and on any rule that could let a portal login reach a database
   other than the portal's). Any difference, missing or extra, other than an
   absent role or database this run creates, refuses: exit 1, one line per
   difference on stderr, nothing written.
2. Absent roles and logins are created; existing logins get the new password
   (sent as a SCRAM verifier). The database is created if absent.
3. Each login tries every other database and must be refused by pg_hba
   (`28000`). This runs after step 2, so a refusal here names what the run
   had already done (logins created or passwords rotated, an empty database
   created) instead of saying nothing changed.
4. In the portal database, one transaction: the check again, the ORM's
   pending migrations (drizzle's own loop, replayed on this transaction), the
   grants on what they created, and the check against the full manifest
   before commit.
5. A smoke test connects as each login (`42501` permission denied, `28000` no
   tenant bound).

Concurrent runs are serialised by an advisory lock. PostgreSQL scopes advisory
locks to one database, so the session lock held on the maintenance database
serialises only runs that name the same maintenance database; the portal
transaction takes the same lock in the portal database and re-checks before
it writes, so runs through different maintenance databases still cannot
interleave there.

A re-run changes nothing but the passwords. A refusal is a security event: the
per-difference fix is a manual step for the administrator, never this command.
The server must be a PostgreSQL major version with a committed catalog
snapshot (`SUPPORTED_MAJORS` in `provision/catalogSnapshot.ts`).

What no in-database check can see, stated plainly: a superuser (who can edit
the catalogs), files and configuration beyond pg_hba, rights hard-coded in the
server rather than stored in a catalog, any new setting or rule a future
server adds that the catalog snapshot cannot show, and changes made after the
command has run: it checks at provision time and is not a monitor.

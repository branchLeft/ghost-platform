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
- The work cannot keep a different binding. Before the commit, `run` reads the
  tenant register through the typed query builder (`assertBindingIntact`,
  `src/tenant/binding.ts`) for any row but the scope's own. Under the tenant
  role and the bound tenant the register holds at most that one row, so another
  row means the work rebound the session (`portal.tenant_id` or
  `portal.organisation_id`, by `set_config` or `SET LOCAL`) or stepped out of
  the role on a login that sees more. The run is then refused with
  `TenantBindingChangedError` and the transaction rolls back whole, so nothing
  the work read or wrote leaves it. A probe that itself fails (the role was left
  and its privileges went with it, or the transaction was left aborted) is
  refused the same way, with the failure as the `cause`. The cost is one
  indexed register read per run. `Tx` stays the full Drizzle transaction:
  `execute` and `select({ x: sql... })` take raw statements, so narrowing the
  type would not be a control, and the check is what is proven
  (`test/bindingRebind.test.ts`, on a real server).
- All access is Drizzle. The schema (`src/schema.ts`) declares the policies and
  `drizzle/` holds the generated migrations. A schema module is checked by
  `assertTenantTablesIsolated`: a table with a `tenant_id` column must have row
  security and a `tenant_isolation` policy that is permissive, `FOR ALL`,
  explicitly `TO portal_tenant`, whose `USING` and `WITH CHECK` both render
  (whitespace and quoting aside) to `<schema>.<table>.tenant_id =
  public.bound_tenant()`. A policy of `true`, another column or function, an
  `OR true`, a missing `WITH CHECK` or a parameter is refused with
  `UnisolatedTableError` naming the table. Other policies on a table are not
  judged here: the provisioning command's live check (M20) pins the deployed
  set exactly.
- `TenantDb.scopeForOrganisation` resolves a Zitadel organisation to a scope. It
  binds the organisation (`portal.organisation_id`) instead of a tenant, and a
  second policy lets that binding read the one register row for that
  organisation, nothing else.

What the binding check cannot see, stated plainly: it reads the state the work
leaves behind. Work that rebinds, reads, and rebinds back before it returns
passes it. Closing that needs a binding the tenant role cannot set, a
database-level control in the schema or the provisioning command, which this
layer does not have; nothing under `portal/apps` can express a raw statement
through `run` today. The anchor is the register row: a tenant table's foreign
key to the register (as `health_reading` has) means a rebind to a tenant that
has data always exposes a register row, and a rebind to a tenant not in the
register exposes nothing.

### Policies

`public.bound_tenant()` raises when neither a tenant nor an organisation is
bound, so an unbound statement fails instead of returning nothing or
everything. When only an organisation is bound it returns null: no tenant row
matches, and the `organisation_lookup` policy exposes just that organisation's
register row, which is how a session's organisation becomes a bound tenant.

The register's writes are pinned twice (`test/registerWrites.test.ts`). The
manifest grants `portal_tenant` `SELECT` only, so the test shows the role holds
no `INSERT`, `UPDATE` or `DELETE` and that each is refused with `permission
denied`. And with those writes granted for the test and revoked in a `finally`,
the `tenant_isolation` policy itself refuses a row for another tenant, an
update that moves a row to another tenant, and a delete of another tenant's
row removes nothing, so a `WITH CHECK (true)` there cannot go unnoticed.

### Tenant kind

`portal.tenant_register.kind` says whether a tenant is `REAL` or a `DEMO` slot
(`TENANT_KINDS`, defined once in `src/tenantKind.ts`). It is the one source of
the kind: `TenantDb.ownKind(scope)` reads it from the bound tenant's own row.
The column is `NOT NULL` with no default and a check against the closed list, so
a row that names no kind, or a wrong-case one, is refused by the database, and
`OwnerDb.registerTenant` refuses it first (`InvalidTenantKindError`). Only the
owner role writes it; the tenant role holds `SELECT` on the register and
nothing else, so a tenant cannot change its own kind. `parseTenantKind` is
strict: it throws on anything but an exact member and defaults to neither kind.
Migration `0005_tenant_kind` adds the column; on a register that already holds
rows it fails rather than guess a kind.

### Raw SQL

Exactly three things are not expressed through Drizzle (`DB-2` approval, owner
ruling): the role switch (`SET LOCAL ROLE`, `enterRole` in `src/db.ts`), the
binding call (`set_config`, `bind` in `src/db.ts`), and the binding functions
(`drizzle/0000_binding_functions.sql`, called from the policy predicates in
`src/schema.ts`). The binding check in `run` is a typed Drizzle query and the
isolation comparison renders the policy's predicates and compares text, so
neither adds raw SQL. `provision/` holds the operator's role and grant statements,
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

`document_version` has no row-level policy: it holds no tenant's data, and a
policy that raises on an unbound tenant fires per row, so on an empty table it
would assure nothing. `TenantDb` still takes a scope for every read of it.

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

## Moderation settings

`portal.moderation_setting` holds one row per tenant and comment check: on or
off, and a sensitivity, with who changed it and when. A tenant has a row only
for a check it has saved; the page shows placeholder defaults for the rest. The
page reads the saved rows back for a `REAL` tenant; nothing enforces them.

The table is closed to the configurable comment checks. A database constraint
(`moderation_setting_check_configurable`) refuses any other check id, so a
mandatory-floor or absolute check cannot be stored even by a statement that
skips the code, and the manifest's shape check (M21) refuses a server in which
that constraint is missing. `TenantDb.saveModerationSettings` refuses the same
ids first with `UnknownCheckError`, all or none, and the tenant is always the
scope's. It takes row locks in the order the changes are given, so two saves in
opposite orders can deadlock (one rolls back, cleanly): a caller other than the
save route must pass the changes in `COMMENT_CHECKS` order, the order the route
uses. The tenant role holds `SELECT`, `INSERT` and `UPDATE` on it, nothing
deletes a setting, and the owner role has no grant on it.

## The demo lifecycle, its term and the hostname register

A demo is the owner side's record of one prospect's tenancy; the lifecycle
document (`ghost-platform-docs/19-try-it-now-design/12-demo-lifecycle.html`,
sections 03 and 05) owns the design. Three tables hold it. None has a tenant
column or a row policy, and the protection is the grants, as for
`document_version`.

**States and transitions.** `src/demoStates.ts` holds one closed list of 14
states (`VERIFIED`, `WAITING`, `CLAIMED`, `PROVISIONING`, `LIVE`, `EXTENDED`,
`EXPIRING`, `REBUILDING`, `PROMOTING`, `PROMOTED`, `FAILED`, `KILLED`, `FROZEN`,
`PURGED`) and the one closed set of allowed moves between them. The five
terminal states (`PURGED`, `FAILED`, `KILLED`, `FROZEN`, `PROMOTED`) have no way
out, a self-transition is refused, and the kill switch and content flag
(`KILLED`, `FROZEN`) leave every state that holds a slot (`CLAIMED` to
`PROMOTING`). A new demo for the same address is a new demo, not a move.
`portal.demo_state_event` is append-only: one row per transition, with its time
on the database clock and the term then in force, and no person. The current
state is the latest row. The database refuses what the code would not write:
a check pins the allowed pairs, a foreign key makes each row continue the
demo's real previous row, and the primary key on (demo, sequence) lets only
one of two simultaneous transitions from a state win (the other gets
`ConcurrentTransitionError`). Three rules are code's: an extension is
`extend`'s and never a bare transition, a promotion that does not complete
returns to the state it came from, and a lease is carried on unchanged.

**The term.** Entering `PROVISIONING` issues a term of exactly seven days
(`LEASE_DAYS`), starting at that row's own database-clock time: no operation
takes a time from its caller, and a check refuses a `PROVISIONING` row whose
issue time is not its own record time or whose end is not seven days on. The
end is never null from `PROVISIONING` on. A self-service extension
(`ProvisionerDb.extend`, LIVE or EXPIRING to EXTENDED) moves the end on by 14
days (`EXTENSION_DAYS`) and changes nothing else: the issue time, the hostname
and every earlier row are as they were, and it appends one row. There is one
extension per demo; any further time is the owner's, not built here, and the
tables do not forbid it. A rebuild (`REBUILDING` to `LIVE`) keeps the end it
had, so a rebuild on day six still ends on day seven. The transition set has
no `REBUILDING` exit from `EXTENDED`, so a dead extended demo cannot be
rebuilt as the table stands.

**The register.** `portal.hostname_register` holds every hostname ever
allocated: the label, an opaque demo id and the allocation time, and nothing a
prospect typed. The label is the primary key, so a name is never given twice,
and the demo id is unique, so a demo has one hostname for its whole life (a
rebuild keeps it). The label is 20 base32 characters (100 bits) from the
operating system's random source, takes nothing from the demo or the slot, and
a check pins its shape. Retirement is a row in `portal.hostname_retirement`,
keyed on the label, never an edit of the register; a retired label cannot be
allocated again, and a label not in the register or already retired is refused
(`UnknownHostnameError`, `HostnameRetiredError`).

**Who writes them.** `portal_provisioner`, a third role, used only by the
control-plane lifecycle worker (not built here) through
the `./provisioner` export (`ProvisionerDb`). It can
`INSERT` and `SELECT` the three tables and can neither `UPDATE` nor `DELETE` any
of them: refused at the permission level, SQLSTATE `42501`, which the provisioning
command's own check (M06) and smoke test both hold. The owner role may only
`SELECT` them (`OwnerDb.listDemos`, `demoHistory`, `demoHostname`,
`listHostnames`); the tenant role holds nothing on them. The internet-facing
prospect path is a separate role, not made here.

Control cases (each is a test that fails if the mechanism is removed): the
full 14 by 14 matrix of states, through the operation and straight at the
table; the term read back from the stored row; the extension's before and
after record; a rebuild's end; the label's uniqueness, with two simultaneous
allocations; and the provisioner's `UPDATE` and `DELETE` refused with `42501`.

## The owner path

`portal/data` exports `./tenant`, `./owner` and `./provisioner` separately.
Tenant-facing code imports the first only; a test fails if anything under
`src/tenant` imports the owner path, the provisioner path or the migrator. The owner pool connects as a login that is a member
of `portal_owner` alone, so the tenant-facing connection cannot assume that role.

## Running the tests

```sh
nvm use && npm ci
PORTAL_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/postgres npm run coverage
```

The URL must be a superuser on a throwaway cluster started with
`test/pg_hba.ci.conf` as its `hba_file` (it names each test login, the
provisioner's included) (writable by the server's user, since
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
| `PORTAL_PROVISIONER_PASSWORD_FILE` | password for the provisioner login (printable ASCII) |
| `PORTAL_DATABASE_NAME`        | optional, default `portal`                            |
| `PORTAL_TENANT_LOGIN`         | optional, default `portal_tenant_login`               |
| `PORTAL_OWNER_LOGIN`          | optional, default `portal_owner_login`                |
| `PORTAL_PROVISIONER_LOGIN`    | optional, default `portal_provisioner_login`          |

The three logins must differ and their passwords come from three files. A full
run needs all three password files: the manifest is closed, so a run without
the provisioner's is refused rather than provisioning two of three.

The command creates what is absent, checks everything, and repairs nothing.
`provision/manifest.ts` is the closed manifest: the three roles and three logins
with their exact attributes (all `NOINHERIT`; the apps always `SET LOCAL
ROLE`), one membership per login, and every grant, each justified by a call
site. No role may `DELETE`, the owner role may not `UPDATE` the tenant register,
and the provisioner role may not `UPDATE` anything.

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
   tenant bound; the provisioner login may read what it writes and may neither
   update nor delete it).

Concurrent runs are serialised by an advisory lock. PostgreSQL scopes advisory
locks to one database, so the session lock held on the maintenance database
serialises only runs that name the same maintenance database; the portal
transaction takes the same lock in the portal database and re-checks before
it writes, so runs through different maintenance databases still cannot
interleave there.

### Applying a new migration to a provisioned database

```sh
node dist/provision/provisionMain.js --migrate-only
```

Reads `PORTAL_ADMIN_URL_FILE` (and the optional name variables) and no
password file. It runs steps 1 and 4 only: the check, then one transaction
that applies the pending migrations with their manifest grants and checks the
full manifest before commit. It creates no role and no database and sets no
password, so the logins' stored verifiers are byte for byte unchanged. It
refuses with `migrate refused: role ... is absent` or `migrate refused:
database ... is absent, not provisioned` when the full provision has not run.
A server last provisioned before `portal_provisioner` existed is such a case:
`--migrate-only` refuses naming the missing role and login, and the full run
(with the provisioner's password file) comes first, then `--migrate-only` for
later migrations.
It skips steps 3 and 5, which need the login passwords. Run again with
nothing pending, it applies nothing and prints `no pending migrations`.

A re-run changes nothing but the passwords. A refusal is a security event: the
per-difference fix is a manual step for the administrator, never this command.
The server must be a PostgreSQL major version with a committed catalog
snapshot (`SUPPORTED_MAJORS` in `provision/catalogSnapshot.ts`).

What no in-database check can see, stated plainly: a superuser (who can edit
the catalogs), files and configuration beyond pg_hba, rights hard-coded in the
server rather than stored in a catalog, any new setting or rule a future
server adds that the catalog snapshot cannot show, and changes made after the
command has run: it checks at provision time and is not a monitor.

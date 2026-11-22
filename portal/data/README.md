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

### Tenant name

`portal.tenant_register.tenant_name` holds the name a customer signed up under,
which is also the slug of their repository, database and stack. Customer names
live here and in no repository (the public name register keeps tenant zero and
the infrastructure names only). The control plane refuses a taken name when it
accepts the sign-up: `OwnerDb.registerTenant` normalises a given name the way
the slug is (`normaliseTenantName` in `src/tenantName.ts`: trimmed, lowercased,
then the provisioning workflow's 3-26 character slug rule) and a second tenant
under the same normalised name is refused with `TenantNameTakenError`, which
carries no name. The refusal rests on the table: a `UNIQUE` constraint
(`tenant_register_tenant_name_unique`) and a shape `CHECK`
(`tenant_register_tenant_name_shape`), so two sign-ups racing for one name cannot
both win and a statement that skips the code is refused too. The column is
nullable because a demo slot has no customer name; a null never collides. There
is no lookup endpoint and no key: nothing outside the owner role can ask whether a
name is taken. Migration `0008_tenant_name` adds the column.

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
writes the readings is `portal/apps/src/collector/healthMain.ts`, fed by the
native program in `portal/host/branchleft-health-collect.py` (see
`portal/apps/README.md`). It writes `unknown`, with no scrape at all, for a
tenant when any of its colours could not be read. The grants on `portal.health_reading`
(tenant `SELECT`, owner `SELECT, INSERT, UPDATE`) are in the manifest,
`provision/manifest.ts`.

## Support access

`portal.support_access_reading` holds one row per tenant: whether the support
account on the tenant's own host is `open`, `closed` or `unknown`, with the
grant's lane, start and deadline while it is open, and when the host last
reported. It carries no reason, no reference and no identity. The fields are the
ones the grant tool's read-only `report` command prints
(`adapters/sso/scripts/break-glass-grant.md`). The tenant role holds `SELECT`
alone, so nothing a tenant does can write what the page shows; the owner role
holds `SELECT, INSERT, UPDATE`. `OwnerDb.recordSupportAccess(tenantId, reading,
observedAt)` is the write the collector makes (`portal/apps/src/collector/`),
and `OwnerDb.listTenantSlugs()` is its map from the slug a host's series carry
(the tenant name above) to a tenant id; a tenant with no name is not in it.

`TenantDb.ownSupportAccess(scope, now)` is what the page shows. A reading is
believed for `SUPPORT_READING_FRESH_SECONDS` (900) either side of `now`: no
row, an older or future-dated one, and a state outside the closed list all come
back `unknown` with no deadline. `closed` is returned only for a fresh reading
that says `closed`, so a host that has stopped reporting never reads as closed.

`portal.professional_enquiry` holds one row per Professional enquiry the tenant
portal has sent: the tenant, the database-clock time and nothing else, no contact and
no text. `TenantDb.recordProfessionalEnquiry` inserts the bound tenant's row (the
tenant role's `tenant_isolation` policy and `INSERT` grant only; it cannot read the
table). `OwnerDb.countProfessionalEnquiries` counts every row for the owner console's
landing page. Migration `0017_professional_enquiry`. Nothing updates or deletes a row.

`portal.support_access_request` holds a tenant's requests: each row has its own
id, the tenant id, the database-clock time and a `status` (`open` or
`dealt_with`, default `open`, held by a CHECK), and no column that holds text.
A partial unique index (`support_access_request_one_open`, on the tenant where
the status is `open`) allows one open request per tenant and any number dealt
with, kept as history. The tenant role may `INSERT` its own row
(`TenantDb.requestSupportAccess`, which takes the tenant from the scope and
ignores a repeat while one is open) and `SELECT` it; a restrictive insert
policy makes the row it files `open`, and `TenantDb.ownSupportRequest` returns
the latest. The tenant role holds no `UPDATE`, so it cannot change a status.
The owner role may `SELECT` (`OwnerDb.listSupportRequests`, open requests first
and oldest first, no paging) and `UPDATE`: `OwnerDb.markSupportRequestDealtWith`
sets `dealt_with` on a tenant's open request and nothing else. No role deletes
a request, so a request is never withdrawn and a dealt-with row stays. The
provisioning manifest names the index (`NAMED_INDEXES`) and pins its definition.
A request
opens nothing: access
is opened and closed on the tenant's host by the owner, and the portal holds no
way to do either. Both tables are isolated like every tenant table; the
manifest's grants, policies and shapes (`provision/manifest.ts`) pin them, and
`test/supportAccess.test.ts` loosens each control in turn to show its probe
goes red.

## Billing reference and payment state

`portal.tenant_billing` holds one row per paying tenant: an opaque
`billing_reference` (nullable) into whatever invoicing tool the owner uses, a
`payment_state` (`unpaid`, `paid` or `overdue`, no default, held by a CHECK) and
`state_changed_at`, the database's clock, which moves only when the state does.
It is the tenant record's billing half: one row per `tenant_register` row, kept
apart so the register stays insert-only and a tenant can read its own payment
state without the register being widened.

**What it never holds.** No card number, bank detail, name, address, e-mail
address, provider key or token, and no column that could hold free text: the
table has the four columns above and the manifest pins them (a fifth is an
extra). The reference is a token of 3 to 64 letters, digits and `_ . : -`
(`BILLING_REFERENCE_PATTERN`), so a space, an `@` or a URL cannot be stored; one
that is twelve or more digits (`4242-4242-4242-4242` and `4242424242424242`
alike, `CARD_NUMBER_LIKE_PATTERN`) is refused as a mistaken paste. Both rules are
a CHECK on the table as well as in `parseBillingReference`, so a statement that
skips the code is refused too. The card rule is a backstop, not a detector: the
control is that the platform stores a reference and the owner's invoicing tool
holds everything else. The platform makes no call to any payment provider.

**Who writes.** The tenant role holds `SELECT` alone (its own row, by the
`tenant_isolation` policy), so a tenant cannot mark itself paid. The owner role
holds `SELECT, INSERT, UPDATE`; no role deletes a record. `OwnerDb`:

- `setPaymentState(tenantId, state)` creates the record with no reference if
  there is none; repeating the state a tenant already has leaves the clock alone.
- `setBillingReference(tenantId, reference | null)` records, replaces or clears
  the reference; a tenant with no record gets one as `unpaid`, and an existing
  record keeps its state.
- `billingOf`, `listBilling` and `listOverdue` (the longest overdue first) are the
  console's reads. `TenantDb.ownBilling(scope)` is the tenant's read of its own.

Both writes refuse a tenant that is not registered (`TenantNotRegisteredError`)
and a demo slot (`TenantNotBillableError`): only a real tenant is billed. The
console screen, suspension and any provider integration are separate stories.
`test/billing.test.ts` holds the tests; the manifest's grants, policy and shape
(`provision/manifest.ts`) and the closed-world tampers pin the table.

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
gate; its caller is the promotion step, `promoteDemo`, which refuses a demo
whose owner has not accepted the current documents). Only the version in force can be accepted. Text in this layer is
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

## Custom domains

A real tenant connects its own domain in three steps, each a `TenantDb` call:
`requestCustomDomain` (the domain is normalised and refused unless it is a plain
domain name outside every platform-owned domain, and only a `REAL` tenant may
ask), `checkCustomDomain` (a lookup, below) and `connectCustomDomain`.
`removeCustomDomain` disconnects it. Nothing here serves a domain: the edge
serves only what is in `portal.connected_domain`, and wiring that to the edge
is not part of this layer.

Two tables, both isolated like every tenant table. `portal.custom_domain_request`
holds the unproven asks, one row per tenant and domain with a one-time token
(32 characters of base32, 160 bits, from the operating system's random source);
it is not unique across tenants, so an unproven ask never blocks a domain's real
owner. `portal.connected_domain` holds the connections, keyed by the domain, so
a domain is connected to one tenant at a time and a second tenant's connection
is refused by the table (`connected_domain_pkey`) even to a statement that skips
the code. The portal maps that refusal to `CustomDomainTakenError`, which names
neither the domain nor the tenant. Both tables check the stored name against the
same pattern the code normalises to.

**The check.** `checkCustomDomain(resolver, edgeTarget, { fqdn, token }, now)`
passes only when every address the domain resolves to is one of the edge's (or
the domain is a CNAME to the edge's name), and a TXT record at
`_publicpress-verify.<domain>` holds `publicpress-verify=<token>`. A domain that
also answers at an address the edge does not hold is not pointed at it. A lookup
that fails for any reason other than "no such record" throws
`DnsLookupFailedError`: the check never passes on a failed lookup. The resolver
is a seam (`nodeDnsResolver(servers)` is the real one).

**The proof.** A passing check returns a `DomainProof`, and
`connectCustomDomain` accepts nothing else. A proof has no public constructor
(`checkCustomDomain` is the only way to make one) and is looked up in a
registry on use, so a look-alike object is refused. It is also refused when older
than ten minutes or dated ahead, and when the domain was not requested by this
tenant or the proof's token is not the one the request holds. This is a
type-and-registry control inside trusted application code; the database cannot
see DNS, so a tenant-role statement that skips the code can still insert a
connection, which is why the edge's own admission (`ghost-platform` `services/odask`)
must stay the second gate.

**Grants.** This is the one place a tenant deletes its own rows: the tenant role
holds `SELECT`, `INSERT` and `DELETE` on the two tables, never `UPDATE`, and the
owner and provisioner roles hold nothing on them. A test pins that exact set.

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
`extend`'s and never a bare transition, a promotion or a rebuild that does not
complete returns to the state it came from, and a lease is carried on
unchanged.

**The term.** Entering `PROVISIONING` issues a term of exactly seven days
(`LEASE_DAYS`), starting at that row's own database-clock time: no operation
takes a time from its caller, and a check refuses a `PROVISIONING` row whose
issue time is not its own record time or whose end is not seven days on. The
end is never null from `PROVISIONING` on. A self-service extension
(`ProvisionerDb.extend`, LIVE or EXPIRING to EXTENDED) moves the end on by 14
days (`EXTENSION_DAYS`) and changes nothing else: the issue time, the hostname
and every earlier row are as they were, and it appends one row. There is one
extension per demo; any further time is the owner's, not built here, and the
tables do not forbid it. A rebuild keeps the end it had, so a rebuild on day six
still ends on day seven. A `LIVE` demo is rebuilt through `REBUILDING` and back
to `LIVE`; an `EXTENDED` demo (owner ruling, 28 Oct) through `REBUILDING` and
back to `EXTENDED`, by a bare transition that adds no days and is not a second
extension, so the extended end is kept and a rebuild never adds time. Expiry
stays final: an `EXPIRING` demo cannot be rebuilt.

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
`SELECT` the three tables and `INSERT` into them by column, and can neither
`UPDATE` nor `DELETE` any of them: refused at the permission level, SQLSTATE
`42501`, which the provisioning command's own check (M06, M07) and smoke test
both hold. The `INSERT` leaves out the one timestamp each table has
(`recorded_at`, `allocated_at`, `retired_at`), so the database's clock stamps
every row and a raw-SQL writer holding the role cannot backdate a demo's term
or a hostname's allocation: an insert that names one, even as `DEFAULT`, is
refused with `42501`. `ProvisionerDb` therefore inserts through the narrowed
shapes in `src/provisioner/insertShapes.ts`, which a test holds to the schema
and to the manifest's column grant. The manifest's grants take a `columns`
list for this (rendered as `GRANT INSERT (...) ON TABLE ...`, checked by M07). The owner role may only
`SELECT` them (`OwnerDb.listDemos`, `demoHistory`, `demoHostname`,
`listHostnames`); the tenant role holds nothing on them. The internet-facing
prospect path is a separate role, `portal_prospect`, below.

**The waiting list.** Six slots are offered (`SLOT_COUNT`). A demo holds one
from `CLAIMED` to `PROMOTING`; `ProvisionerDb.admit` decides, for a demo at
`VERIFIED` whose request is recorded, whether it is `CLAIMED` or `WAITING`. A
full house is an outcome and never an error: the request goes onto the list as
`WAITING`, keeps the request row the front door wrote (the same contact details,
consent and explainer wording, read through `ProvisionerDb.request` and
`OwnerDb.demoRequest`), holds no term and no hostname, and comes back with its
place in the queue. A request is `CLAIMED` only when fewer than six demos hold a
slot and nobody is waiting (a demo holds one in a state from `CLAIMED` to
`PROMOTING`, and also when it is `FAILED` with its hostname not yet retired:
the worker retires a failed demo's hostname only once its slot is free, so an
unretired hostname on a `FAILED` demo is the record that the slot still needs a
reset or a person), so a later request never passes an earlier one; a
slot that frees while someone waits is for the front of the list, offered by a
later step that is not built here (the move is `WAITING` to `CLAIMED`). The
decision is made under one advisory lock held to the end of the transaction, so
simultaneous requests are decided one at a time and the seventh can never also
take the sixth slot. A demo that is not at `VERIFIED`, or that has no recorded
request, is refused (`AdmissionRefusedError`) and nothing is written.
`OwnerDb.waitingCount` is the console's count of demos on the list.

Control cases (each is a test that fails if the mechanism is removed): the
full 14 by 14 matrix of states, through the operation and straight at the
table; the term read back from the stored row; the extension's before and
after record; a rebuild's end; the label's uniqueness, with two simultaneous
allocations; and the provisioner's `UPDATE` and `DELETE` refused with `42501`.

## The front door's request

A prospect who has signed in through the identity service submits one request
at the front door: the answers to the onboarding form, the address the identity
service verified, the exact wording of the consent and of the sign-in
limitation explainer as it was shown, and the database's own time. The
lifecycle design (`ghost-platform-docs/19-try-it-now-design/12-demo-lifecycle.html`,
sections 05 to 07) owns the design; this is the owner side's record of it.
`portal.demo_request` holds it, one row per request, keyed on the opaque demo id
the lifecycle will run under. It has no tenant column. The protection is the
grants and, for the front door's read, an own-row policy (below).

**Who writes and reads it.** `portal_prospect`, a fourth role, used only by the
internet-facing prospect application through the `./prospect` export
(`ProspectDb`). It can `INSERT` a request and read its own, and holds nothing
else: it cannot update or delete one, and touches no other portal table. The
process a stranger can reach therefore appends a request and can neither
allocate a name, sign a descriptor nor read another prospect's answers.
`portal_provisioner` (`ProvisionerDb.request`) and `portal_owner`
(`OwnerDb.listRequests`, `OwnerDb.demoRequest`) read every request; no role
updates or deletes one. The prospect login is a member of the prospect role
alone and is admitted to the portal database alone, like every login.

**The front door reads its own row.** `ProspectDb.ownRequest(address)` binds
the verified address to the transaction (`portal.prospect_address`) and selects
from the table with no `WHERE`. Row security is on for the table and three
permissive policies decide who sees what: `own_request` lets `portal_prospect`
`SELECT` the rows where `verified_address = public.bound_address()` and no
others; `request_insert` lets it `INSERT`; `provisioner_read` lets
`portal_provisioner` read. The owner role bypasses row security by attribute.
`public.bound_address()` reads the binding back and returns null when nothing is
bound, so an unbound statement sees no request. It returns the request's demo
id, the publication name and the time it was recorded, which is what a status
page needs; the lifecycle state is not here, because the front door cannot read
it. The `SELECT` privilege is by column, on those three columns alone
(`demo_id`, `publication_name`, `submitted_at`), and the policy narrows the
rows: a statement that skips the typed read still sees one row at most, and a
statement that names any other column, or `*`, is refused with `42501`.

*Why by column.* A session on the front door's connection can set
`portal.prospect_address` to any value, so the row policy alone does not stop a
compromised front door reading the row of an address it can guess. The column
grant caps that: the address, the subject, the consent wording and the answers
are out of its reach whatever it binds. The manifest records the grant with
`columns`, and the provisioning check (M07) pins it exactly, so a table-wide
grant (M06) or a grant on a fourth column (M07) is refused. The tenant binding
(`portal.tenant_id`) has the same property and is the isolation the tenant
tables rest on; it is not changed here.

**One request per verified address.** The verified address is unique over all
time: a second submission for an address is refused by the table
(`demo_request_verified_address_unique`, SQLSTATE `23505`) whichever process
sends it, and `ProspectDb.submit` turns it into `DemoRequestExistsError`. This
is stricter than "one open demo per address": an address whose demo FAILED may,
by design, start another, and that supersession is not built here (it needs the
lifecycle worker's say, since the front door cannot read a demo's state).

**What the table checks.** The address is lower-case with one `@` and a dotted
domain and at most 254 characters; the name, description, import source and
wording have length bounds; the colour is lower-case `#rrggbb`; the theme,
font and outlet type are slugs; the logo hash is 64 lower-case hexadecimal
characters. `src/demoRequest.ts` holds each pattern once and parses a
submission to a typed `InvalidDemoRequestError` that names the field and never
the value. The lists the slugs belong to (the curated themes, the font subset,
the outlet types) are the application's; the table fixes only their shape.
The logo itself is not stored here: the hash is of an image the safety service
has passed.

Control cases (each a test that fails if the mechanism is removed): the
request recorded with every answer and the database's time; a second request
for one address refused at the table and, for two simultaneous submissions,
exactly one winning; the front door's `UPDATE`, `DELETE` and `TRUNCATE` refused
with `42501` and shown to be the grant by granting it inside a rolled-back
transaction; every check refusing a direct insert with `23514`; the front door
reading its own request and no other (`test/prospectStatusRead.test.ts`), shown
to be the policy by rewriting it to `true`, adding a second permissive policy
and switching row security off, each inside a rolled-back transaction; the
provisioning command's own smoke test and closed-world fixtures refusing a
widened or missing grant and a policy that reads another address (M06, M08,
M09, M20).

The closed-world manifest holds policies of this shape as well as the tenant
one: each entry names the role it is written `TO`, its command, and its
`USING` and `WITH CHECK` text as the server deparses them, so an own-row policy
rewritten to `true`, a second permissive policy, or a policy for `PUBLIC` is an
extra, and a dropped one is missing. A grant or row-security switch that a
later migration adds (`added`, `enabledFrom`) is expected only once that
migration is applied, so a server held back still verifies.

## The demo extension request

A prospect whose demo is running may ask for more time. The request is
`portal.demo_extension_request` (migration `0016_demo_extension_request`): what
they are still evaluating, what is missing, an audience-size band, whether they
charge readers, when they would move, their consent to be contacted, the exact
consent wording they were shown and the database's own time. It is keyed on the
demo id and references the demo's request, so it is one row per demo for all
time, matching the demo's one self-service extension.

**Who writes and reads it.** `portal_prospect` can `INSERT` (`ProspectDb.requestExtension`)
and holds nothing else on the table. An insert policy admits the row only when
the demo's own request is one the front door can see: it holds no SELECT on the
address column, so the policy names the demo alone and the request table's own-row
policy (the address the transaction bound) narrows what it finds. A prospect
cannot file for another address's demo; with nothing bound it is
refused. `portal_provisioner` can `SELECT` (`ProvisionerDb.extensionRequest`).
No role updates or deletes a row, so consent once recorded cannot be altered.

**The grant.** `ProvisionerDb.grantExtension(demoId)` refuses unless the demo
has a request carrying consent wording, then calls `extend`: the end of the
term moves on by 14 days and the demo goes to `EXTENDED`, under the existing
rules (only from LIVE or EXPIRING, once). A demo with no request moves
nothing (`ExtensionRefusedError`, reason `consent`). `extend` itself is
unchanged, so the lifecycle worker's own use of it is not gated by a request.

**Consent.** `parseDemoExtension` refuses first on consent: anything but
boolean `true` is `InvalidDemoExtensionError('consent')` before a statement is
spent, so a request without consent writes no row. The wording stored is the
one the caller passes (the front door's own constant, never a browser field);
the table refuses an empty wording. The audience bands and move horizons are
placeholders in `src/curatedLists.ts` until the owner rules on them.

Whether an extension may be repeated is for the design revision to settle; today
the one-per-demo rule stands.

Control cases (`test/demoExtension.test.ts`): the request recorded with every
answer and the database's time; a granted request moving the term by exactly 14
days; a request without consent refused with no row and no lifecycle row; a
grant with no request refused; a second request, a second grant and a grant
outside LIVE or EXPIRING refused; the front door refused another address's demo
and an unbound insert; the front door's read, update and delete and the
worker's update and delete refused with `42501`.

## Tenant erasure requests

`portal.tenant_erasure_request` is a tenant's own request to erase its whole
site (migration `0015_tenant_erasure_request`): one row per tenant for all time
(its primary key is the tenant), the database's time of the request, a status
(`requested`, then `key_destroyed`) and the database's time at which the owner
role recorded that the tenant's backup key was destroyed. It has no column that
holds text. A check ties the two together: `requested` never carries a key
moment and `key_destroyed` always does.

**Who writes and reads it.** `portal_tenant` can `INSERT` its own row
(`TenantDb.requestOwnErasure`) and `SELECT` it (`TenantDb.ownErasure`). A
restrictive insert policy admits only a plain `requested` row, so a tenant
cannot file a request that already says its key is destroyed. `portal_owner`
can `SELECT` and `UPDATE` (`OwnerDb.listErasureRequests`,
`OwnerDb.recordKeyDestroyed`). Nothing deletes a row, and the tenant role has
no `UPDATE`.

**What a row means.** It destroys nothing. The key is destroyed on the control
host by `erase_tenant_backup_identity.py`, and the owner role is told only from
that command's own green proof line (the console's erasure recorder).
`recordKeyDestroyed` moves a `requested` row and nothing else: a tenant that
never asked cannot be recorded, and a second recording keeps the first moment.

**What it may be shown as.** `deriveErasureView` returns `key_destroyed` only
for a row that says so and carries its moment; anything else that exists is
`requested`. A `key_destroyed` view carries the residual window as a constant:
around 46 days from the moment the key was destroyed, `upperBoundDays: null`
(typed `null`, not `number`) and the reason code `ANCHOR_DUMP_NEVER_PRUNED`.
The pruner never deletes the anchor dump however old it is, so there is no
bound, and no value derived from the clock can read as an end date.

**Other tables erasure must cover.** This table records a request; it is not an
inventory of what holds a tenant's data. Any store added later that holds
tenant data (for example reader analytics) is part of an erasure, and its
design must say how: by the tenant's own backup key, by a per-tenant delete, or
as data the portal never held.

Control cases (`test/tenantErasure.test.ts`): a tenant files one row with the
database's clock and a second request records nothing; tenant B sees nothing of
tenant A's row and cannot file for it; a tenant cannot file an already-destroyed
row nor update or delete its own; the status is held to the closed list and the
moment to the status; a tenant that never asked cannot be recorded as erased.
Sabotage: an `UPDATE` grant to the tenant role lets it declare its own key
destroyed, a lifted insert restriction lets it file an already-destroyed row,
and a dropped moment check stores a destroyed row with no moment which is
still shown as requested; each is restored and refused again.

## Moderation queue

`portal.moderation_item` holds one row per held subject for a tenant: the
subject's kind and Ghost id, the member's id, the classifiers (name,
confidence, floor-or-setting state), the status (`held`, `released`,
`removed`, `expired`) and who decided it and when. It stores references and
scores only. The comment text, the member's display name and the post are
never written: `TenantDb.openModerationItem(scope, id, source)` reads the item,
then asks the `ContentSource` (the connection to the tenant's own Ghost) for
the content now, returns it and writes nothing. A source that resolves to null
means Ghost no longer has the subject and the item comes back as `gone`; a
source that rejects is an error, never `gone`.

Every method takes the scope, the table is isolated like the others, and an
id belonging to another tenant reads as absent. `holdItem` refuses anything
that is not a bounded reference or an exact classifier (`InvalidQueueItemError`),
and the table refuses the same references itself. The database cannot check
what is inside the `classifiers` JSON; the code's exact-shape check is the
control there. A subject is held once per tenant: holding it again returns the
existing item. The tenant role may insert and select; nothing updates or
deletes an item yet, and the owner role has no grant. The Ghost-facing
`ContentSource` and the release and appeal actions are separate work.

## The owner path

`portal/data` exports `./tenant`, `./owner`, `./provisioner` and `./prospect` separately.
Tenant-facing code imports the first only; a test fails if anything under
`src/tenant` imports the owner path, the provisioner path or the migrator. The owner pool connects as a login that is a member
of `portal_owner` alone, so the tenant-facing connection cannot assume that role.

## Recovering from a stopped first run

A full run that stops on an already-initialised database, after it has created
roles (steps 2 to 4), leaves those roles holding no grants. The next run refuses,
naming each missing grant, for example `missing M05: USAGE on schema portal to
portal_prospect`. The command never repairs this itself: a stopped run and a
tampered role look the same, so both are refused. A stopped run on a fresh
server needs no recovery: the next run completes the database.

If the refusal names roles with no grants, and you know the failed run created
them, drop those roles on the database host as the administrator, then re-run
the full command. Drop only the roles the refusal names. A refusal naming a role
with no grants means exactly this, or that privileges were removed by hand:
investigate before dropping anything.

Connect without a secret on the command line. The administrator password goes
in a password file, never in the URL or in an argument list (`ps` shows
arguments to every local user). Create it with mode 0600, one line:

```text
<host>:<port>:postgres:<administrator>:<password>
```

Then, with `PGPASSFILE` naming that file, run:

```sh
PGPASSFILE=/path/to/pgpass psql -h <host> -p <port> -U <administrator> -d postgres -v ON_ERROR_STOP=1 -c 'DROP ROLE portal_prospect' -c 'DROP ROLE portal_prospect_login'
```

The role is dropped first, so a refusal (the role holds a grant, a privilege or a
policy reference) stops before the login is touched; `ON_ERROR_STOP` stops the
run at the first error. Use your configured login names if they differ from the
defaults in the table above. Delete the password file afterwards.

## Running the tests

```sh
nvm use && pnpm install --frozen-lockfile
PORTAL_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/postgres pnpm run coverage
```

The URL must be a superuser on a throwaway cluster started with
`test/pg_hba.ci.conf` as its `hba_file` (it names each test login, the
provisioner's and the migrator's included) (writable by the server's user, since
the pg_hba tests rewrite and restore it), because the provisioning command
refuses any rule that lets a portal login reach another database. CI runs the
suite on PostgreSQL 14 and 17. The suite creates and drops its own databases.
After a schema edit, `pnpm run generate` writes the migration; CI fails if the
committed one differs.

## Provisioning a database

One command, run by the operator as a database administrator and never by the
portal. In the portal-apps image, from `/app/portal/data`:

```sh
node dist/provision/provisionMain.js   # or: pnpm run provision
```

Every input is a file named by an environment variable; a secret in argv or in
the variable itself is refused.

| Variable                           | Holds                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `PORTAL_ADMIN_URL_FILE`            | administrator connection URL (host and user required)                         |
| `PORTAL_TENANT_PASSWORD_FILE`      | password for the tenant login (printable ASCII)                               |
| `PORTAL_OWNER_PASSWORD_FILE`       | password for the owner login (printable ASCII)                                |
| `PORTAL_PROVISIONER_PASSWORD_FILE` | password for the provisioner login (printable ASCII)                          |
| `PORTAL_PROSPECT_PASSWORD_FILE`    | optional: password for the prospect login (printable ASCII); see below        |
| `PORTAL_MIGRATOR_PASSWORD_FILE`    | password for the migrator login (printable ASCII)                             |
| `PORTAL_MIGRATOR_URL_FILE`         | `--migrate-only` only: the migrator login's connection URL, password included |
| `PORTAL_DATABASE_NAME`             | optional, default `portal`                                                    |
| `PORTAL_TENANT_LOGIN`              | optional, default `portal_tenant_login`                                       |
| `PORTAL_OWNER_LOGIN`               | optional, default `portal_owner_login`                                        |
| `PORTAL_PROVISIONER_LOGIN`         | optional, default `portal_provisioner_login`                                  |
| `PORTAL_PROSPECT_LOGIN`            | optional, default `portal_prospect_login`                                     |
| `PORTAL_MIGRATOR_LOGIN`            | optional, default `portal_migrator_login`                                     |

The five logins must differ. A full run needs the tenant, owner, provisioner
and migrator password files: a run without one is refused rather than
provisioning the others alone. The prospect password file is the one optional
file, because the front door that will use the prospect login is not built yet
and nothing holds its password. Without the file, a run that creates the login
gives it a random password made in memory, used for that run's probes and
written nowhere, so no one holds it; a run that finds the login already there
leaves its password as it is, probes the other databases with a wrong one and
skips the prospect login's smoke test, and says so in its output. Naming the
file in a later full run sets the password. So a server provisioned before the
prospect login existed reaches the newest migrations with no secret typed for
it: the full run creates the role and login, gives them what the manifest grants
on what is already there, and applies the pending migrations.

The command creates what is absent, checks everything, and repairs nothing.
`provision/manifest.ts` is the closed manifest: the four roles and five logins
with their exact attributes (all `NOINHERIT`; the apps always `SET LOCAL
ROLE`), one membership per login but the migrator's, and every grant, each
justified by a call site. No role may `DELETE`, the owner role may not
`UPDATE` the tenant register, the provisioner role may not `UPDATE`
anything, and the prospect role may do nothing but `INSERT` a request.

**The migrator login** is the last login. It is no superuser and holds no
`BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION`, is a member of no role,
and is admitted to the portal database alone. It owns the portal database,
the `drizzle` and `portal` schemas, and every table, sequence and function the
migrations make (before PostgreSQL 15 it also owns schema `public`, which the
command hands to it once, when it creates the database; from 15 `public`
belongs to `pg_database_owner`, which is the migrator while it owns the
database). An owner can create the objects the migrations make and grant on them,
which is all the migrations and the manifest's grants need, so the command runs
as it for everything after the roles and the database exist. The administrator
URL (a superuser) creates the roles and the database and is not used again. A
database already provisioned under the administrator's ownership is refused
(`extra M18: database ... is owned by postgres`): the command repairs nothing,
and converting one (reassigning ownership and re-making its grants) is a step
for the administrator.

**Handle the migrator's password and URL as a full-data credential.** It owns its
tables but they have `ENABLE` and not `FORCE ROW LEVEL SECURITY`, so as owner it
bypasses the row-level policies and can `DELETE` any row. It holds less than the
administrator does, but its secret (`PORTAL_MIGRATOR_PASSWORD_FILE`,
`PORTAL_MIGRATOR_URL_FILE`) gets the same custody as one: not in a job log, not
in a long-lived runner, removed after the run.

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
   (sent as a SCRAM verifier). The database is created if absent, owned by
   the migrator.
3. Each login, the migrator's included, tries every other database and must be
   refused by pg_hba (`28000`). This runs after step 2, so a refusal here names
   what the run had already done (logins created or passwords rotated, an
   empty database created) instead of saying nothing changed.
4. In the portal database, as the migrator, one transaction: the check again,
   the ORM's pending migrations (drizzle's own loop, replayed on this
   transaction), the grants on what they created, and the check against the
   full manifest before commit. The transaction refuses on a connection that
   is a superuser or is not the migrator.
5. A smoke test connects as each login (`42501` permission denied, `28000` no
   tenant bound; the provisioner login may read what it writes and may neither
   update nor delete it; the prospect login may insert a request, which is rolled
   back, and may neither read, update nor delete one; the migrator assumes no portal role and creates no
   role).

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

Reads `PORTAL_MIGRATOR_URL_FILE` (and the optional name variables) and no other
file: not the administrator URL, which it never opens (and so a deployment of
the routine path need not hold a superuser credential), and no password file.
It logs in successfully to the portal database alone, as the migrator, and
refuses unless it is connected as the migrator and the migrator is no
superuser. It runs steps 1 and 4 only: the check, then one transaction that applies the
pending migrations with their manifest grants and checks the full manifest
before commit. It creates no role and no database and sets no password, so
the logins' stored verifiers are byte for byte unchanged. It refuses with
`migrate refused: role ... is absent` or `migrate refused: database ... is
created-empty, not provisioned` when the full provision has not run, and with
`migrate refused: cannot connect ... as <migrator>` when the migrator or the
database does not exist. A server last provisioned before `portal_provisioner`,
`portal_prospect` or the migrator existed is such a case: `--migrate-only` refuses, and the full
run (with the password files it needs; the prospect's is optional) comes first, then
`--migrate-only` for later migrations. It skips step 5, which needs the other logins' passwords. Run again
with nothing pending, it applies nothing and prints `no pending migrations`.

**What the routine path does not observe.** A superuser reads catalogs the
migrator cannot, so from the migrator's vantage the check is narrower, and it
says so: after the transaction's final check it prints one
`not observed as <migrator>, M..` line for each mechanism it could not see.

- **M01**: whether a login holds a password and the shape of its verifier
  (`pg_authid` is superuser only, and `pg_roles` masks every password). All
  the other attributes are checked.
- **M27**: `shared_preload_libraries` and `session_preload_libraries` (superuser
  or `pg_read_all_settings`) and `pg_file_settings` (a value written to a file or
  by `ALTER SYSTEM`, applied at the next reload).
- **M28**: the loaded pg_hba rules and the files they came from
  (`pg_hba_file_rules`, `pg_stat_file`). Instead every portal login logs in to
  every other database, the migrator with its own password and the others with
  a wrong one, and requires each to be refused (`28000`). A rule that admits a
  login by a password method (scram, md5, password) shows as `28P01`, and a rule
  that trusts it shows as a success. A rule that admits a login by another method
  (cert, ldap, pam, radius, ident, peer, gss) also fails with `28000`, so it looks
  like a refusal and this probe cannot see it; the full provision's static check
  of the loaded rules covers every method.

The migrator is not given membership of `pg_read_all_settings` or a grant on
`pg_authid`, `pg_file_settings` or `pg_stat_file` to close these: the server
configuration can hold a replication connection string with a password, and an
application login should not read it. The full provision runs as the
administrator and observes all of M01, M27 and M28 before it writes anything.

A re-run changes nothing but the passwords. A refusal is a security event: the
per-difference fix is a manual step for the administrator, never this command.
The server must be a PostgreSQL major version with a committed catalog
snapshot (`SUPPORTED_MAJORS` in `provision/catalogSnapshot.ts`).

What no in-database check can see, stated plainly: a superuser (who can edit
the catalogs), files and configuration beyond pg_hba, rights hard-coded in the
server rather than stored in a catalog, any new setting or rule a future
server adds that the catalog snapshot cannot show, and changes made after the
command has run: it checks at provision time and is not a monitor.

# Portal applications

The tenant portal and the owner console: **two separate applications**, not one
with role checks (`ghost-platform-docs/19-try-it-now-design/08-portal.html`
sections 01, 02 and 10). They share identity and storage and share no query
path.

| | Tenant portal | Owner console |
|---|---|---|
| Entry point | `src/tenant/main.ts` | `src/console/main.ts` |
| Hostname | its own (`PORTAL_PUBLIC_ORIGIN`) | its own (`CONSOLE_PUBLIC_ORIGIN`) |
| Sign-in client | the portal client only | the console client only |
| Role and organisations | `tenant-admin`, the reconciled tenant organisations | `owner`, the owner organisation alone |
| Storage | `portal-data/tenant` (`TenantDb`) | `portal-data/owner` (`OwnerDb`) |

Every visible string is an ALL_CAPS placeholder; real copy needs the owner's
authorisation. Both applications render the same empty shell (navigation, a
landing area, sign-out), and nothing else.

## How the tenant is bound

The tenant comes from the signed-in session's organisation and from nothing
else. At sign-in the application exchanges the code (PKCE), verifies the access
token with `createTokenVerifier` (signature, issuer, its own client id, role,
organisation), then resolves the organisation to a tenant through
`TenantDb.scopeForOrganisation`. An organisation with no register row gets no
session. The resulting `TenantScope` is kept with the server-side session and is
the only thing the landing page is given: the request is not an argument, so a
URL, a form field or a header cannot name a tenant. Without a scope a tenant
query does not compile, and the database refuses an unbound one.

## Moderation settings

`/moderation` shows the mandatory floor read-only and the comment checks as one
form that posts to `/moderation/save`. The save is refused whole for a tenant
whose kind is not exactly `REAL` and for any request that names an absolute or
mandatory-floor check anywhere in a field name (`NotConfigurableError`, from
`assertConfigurable`), then for any field the page does not send. The article
checks are not saved yet and stay disabled. The `tenantKind` seam is not wired
in `main.ts`, so every tenant is a demo until it is.

## Support tickets

A signed-in tenant admin can raise a support ticket from the tenant portal. It
is a form wrapped round one plain-text email, and its value is the context the
portal adds without the tenant typing it. The tenant types two things: a free-text
message and a contact address (the one exception to "nothing the portal already
knew": the session carries no email, so the portal cannot supply it).

The portal does not choose a transport. `createTenantPortal` takes an optional
`support: { mailer, recipient, sender }`: `mailer` is a `SupportMailer`
(`send(message)`, in `src/tenant/supportMailer.ts`), and `recipient` and `sender`
are injected addresses, never literals in source. Without it there is no
`/support*` page or action (all answer 404), no navigation item and no link: the
portal is as it was. An injected address that is empty or holds a line break or NUL
stops the portal being built. `src/tenant/main.ts` does not wire a mailer yet,
so the page is absent until a later change injects one.

What the email carries, as `NAME: value` lines in this order, from the closed
list `CONTEXT_FIELDS` in `src/tenant/supportContext.ts`: `TENANT_ID`,
`SITE_HEALTH`, `GHOST_VERSION`, `VERSION_CHECK`, `MISMATCH_SINCE`,
`OBSERVED_AT`, `SITE_HOST`, `LAST_DEPLOY`, `SCREEN`; then a `----- MESSAGE -----`
line and the tenant's message. Every line is always present. A value the portal
does not hold is the marker `NOT_AVAILABLE`, never an omitted or empty line. A
reading that records no run of mismatching readings shows `MISMATCH_SINCE:
NO_MISMATCH`; no reading at all makes every health-derived line `NOT_AVAILABLE`.
`SITE_HOST` and `LAST_DEPLOY` are always `NOT_AVAILABLE` today: the portal's
tenant data holds neither a site hostname nor a deploy record, and nothing in
`portal/data` was added to supply them.

The email is built on the server at submit time. The tenant identifier, health
and version come from a fresh `ownRegistration(scope)` and `ownHealth(scope)`
read bound to the session's `TenantScope`; the action reads only the `contact`
and `message` fields, so a field, query, header or cookie that names a tenant,
a version or a screen changes nothing. The subject is `SUPPORT_TICKET` and the
tenant identifier. The message sits after the delimiter, so one that imitates a
context line cannot be mistaken for context.

The screen is one of `HOME`, `DOCUMENTS`, `MODERATION` or `SUPPORT`, from a fixed
table in `src/tenant/supportScreens.ts`; a path outside it records
`UNKNOWN_SCREEN`. The shell renders a page without the request and its
navigation is the same everywhere, so each screen carries its screen in the
path: `/support/home`, `/support/documents` and `/support/moderation` are linked
from the landing, documents and moderation screens, `/support` from the
navigation, and each form posts to its own send path (for example
`/support/home/send`). The action for a send path knows its screen from the
table; nothing about it is read from the request.

Header injection is closed: the contact address is refused if it holds a line break
(CR, LF, U+0085, U+2028 or U+2029) or a NUL (checked before trimming) or is not one plausible address (one `@`, no
whitespace, comma, semicolon, angle bracket, quote or backslash, at most 254
characters), and every header value (to, from, reply-to, subject) is checked
again before the mailer is called. The message is trimmed, refused when empty,
and bounded at 1000 characters. Each refusal is a `SupportTicketError` with a
fixed message that never holds what was posted, which the shell turns into its
plain `REFUSED`; the shell logs the error name only. Nothing is echoed back and
no ticket is stored.

Abuse is bounded by a per-tenant fixed window held in memory and driven by the
portal's clock: five tickets an hour (`MAX_TICKETS_PER_WINDOW`,
`WINDOW_SECONDS`). The next ticket redirects to `/support/limited`. A restart
forgets the counts. Origin and session checks are the shell's: a foreign origin
is a 403 and no session is a redirect to sign-in, and neither sends anything.

## Why two applications

A token issued to one application is refused by the other, by client id, by
role and by organisation. `test/units.test.ts` fails if anything under
`src/tenant` imports the owner entry point, the migrator or the console, if
`src/console` imports the tenant entry point or the portal, or if the shared
`src/shell` imports either storage entry point.

## Running

Each application reads its own variables; secrets are read from files.

```text
PORTAL_ISSUER_URL, PORTAL_PUBLIC_ORIGIN, PORTAL_OUTPUTS_FILE, PORTAL_DATABASE_URL_FILE
CONSOLE_ISSUER_URL, CONSOLE_PUBLIC_ORIGIN, CONSOLE_OUTPUTS_FILE, CONSOLE_DATABASE_URL_FILE
```

`*_OUTPUTS_FILE` is the identity reconciler's `outputs.json`. The portal's
allowed organisations are read from it at start, so a tenant added later needs a
restart. `*_DATABASE_URL_FILE` holds the connection URL of a login that is a
member of `portal_tenant` alone (portal) or `portal_owner` alone (console).
The URL may omit the password (`postgres://LOGIN@HOST:PORT/portal`): the `pg`
driver then reads `PGPASSWORD` from the process environment, so the password
need not appear in the URL file. Plain HTTP is accepted only for a loopback origin.

A pending sign-in rides in a cookie sealed under a key drawn at start, so a restart drops every pending sign-in and several instances cannot accept each other's cookie.

Sessions live in this process's memory, so a restart signs everyone out and
there is one instance per application. Build the data layer and the identity
verifier first (`npm ci && npm run build` in `portal/data` and
`services/identity`): this package imports their built output.

## Tests

```sh
nvm use && npm ci
PORTAL_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/postgres npm run coverage
```

The URL is a superuser on a throwaway cluster, as for `portal/data`.

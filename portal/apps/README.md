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
checks are not saved yet and stay disabled. The kind comes from the tenant's own
register row (`TenantDb.ownKind`), supplied inside `createTenantPortal`, so
there is no option to forget. A kind that is absent or not exactly `REAL` or
`DEMO` is an error, never a default: the page answers 500 `FAILED` and renders
nothing, and the save answers 400 `REFUSED` and stores nothing. A valid `DEMO`
keeps the demo notice, no form, and a refused save.

## Support access

`/site-access` shows the signed-in tenant whether support access to its site
is open, closed or unknown, and the deadline while it is open. The state comes
from the tenant's own row only (`TenantDb.ownSupportAccess`); a missing,
stale or unrecognised reading is shown as unknown and never as closed. The page
carries one button, `POST /site-access/request`, which files the signed-in
tenant's request: the handler reads no form field, so no tenant id and no text
can travel with it, and it changes no reading. Once a request is filed the page
shows the latest request's status word (open, then dealt with) and no time, and
the button returns when that request is dealt with. The owner console
lists every request on its landing page on one page, open ones first and oldest
first; each open one carries a button, `POST /support-requests/dealt-with`,
that marks it dealt with. Nothing deletes a request. Nothing under
`portal/` can open or close access, and a test fails if portal source gains a
revoke, a socket into a host, a child process or an ssh client. All wording is
`ALL_CAPS` placeholder until the owner supplies it.

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
stops the portal being built.

`src/tenant/main.ts` builds `support` from the variables below
(`loadSupportSettings`, `src/tenant/supportConfig.ts`) and sends over
authenticated SMTP (`createSmtpSupportMailer`, `src/tenant/supportSmtpMailer.ts`).
Anything missing or invalid turns support off, not the portal: it starts, every
`/support*` path answers 404 and one stderr line names the variables at fault,
never a value.

```text
PORTAL_SUPPORT_SMTP_HOST            the mail server's DNS name, never an IP
PORTAL_SUPPORT_SMTP_PORT            default 587
PORTAL_SUPPORT_SMTP_SECURITY        STARTTLS (default) or IMPLICIT
PORTAL_SUPPORT_SMTP_USER            the login: an address
PORTAL_SUPPORT_SMTP_PASSWORD_FILE   a file holding the login's secret
PORTAL_SUPPORT_SENDER               the From address
PORTAL_SUPPORT_RECIPIENT            where tickets go
```

`PORTAL_SUPPORT_SENDER` and `PORTAL_SUPPORT_SMTP_USER` must be the same address:
the mail server accepts a sender only from the account that logged in, so when they
differ support stays off. STARTTLS logs in only after the upgrade and never falls
back to cleartext; the server's certificate is always verified, and the
certificate must name the host in `PORTAL_SUPPORT_SMTP_HOST`. A failed send
reaches the shell as `SupportTicketError('SEND_FAILED')`, and
stderr gets one line with a short code from a closed set (`CONNECT_FAILED`,
`TLS_FAILED`, `AUTH_FAILED`, `REJECTED`, `TIMEOUT`, `SEND_FAILED`) and nothing the
tenant or the server said.

What the email carries, as `NAME: value` lines in this order, from the closed
list `CONTEXT_FIELDS` in `src/tenant/supportContext.ts`: `TENANT_ID`,
`SITE_HEALTH`, `GHOST_VERSION`, `VERSION_CHECK`, `MISMATCH_SINCE`,
`OBSERVED_AT`, `SITE_HOST`, `LAST_DEPLOY`, `SCREEN`; then a `----- MESSAGE -----`
line and the tenant's message. Every line is always present. A value the portal
does not hold is the marker `NOT_AVAILABLE`, never an omitted or empty line. A
reading that records no run of mismatching readings shows `MISMATCH_SINCE:
NO_MISMATCH`; no reading at all makes every health-derived line `NOT_AVAILABLE`.
`SITE_HOST` and `LAST_DEPLOY` are always `NOT_AVAILABLE`: the portal's
tenant data holds neither a site hostname nor a deploy record.

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
plain `REFUSED`; the shell logs the error name only. A rejected read of the
register row or the health reading is one too (`READ_FAILED`): nothing is sent. Nothing is echoed back and
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
PORTAL_TRUSTED_PROXIES, CONSOLE_TRUSTED_PROXIES   optional: switch on the sign-in limit (below)
```

`*_OUTPUTS_FILE` is the identity reconciler's `outputs.json`. The portal's
allowed organisations are read from it at start, so a tenant added later needs a
restart. `*_DATABASE_URL_FILE` holds the connection URL of a login that is a
member of `portal_tenant` alone (portal) or `portal_owner` alone (console).
The URL may omit the password (`postgres://LOGIN@HOST:PORT/portal`): the `pg`
driver then reads `PGPASSWORD` from the process environment, so the password
need not appear in the URL file. Plain HTTP is accepted only for a loopback origin.

A pending sign-in rides in a cookie sealed under a key drawn at start, so a restart drops every pending sign-in and several instances cannot accept each other's cookie.

Both applications build their database pool in `src/shell/pool.ts`
(`createPortalPool`), and nowhere else. It bounds every wait: 5000 ms to connect
or to wait for a free client, and a server-side `statement_timeout` and
`idle_in_transaction_session_timeout` of 10000 ms each. `query_timeout` is not
used: it rejects without cancelling the statement, and the client then fails on
reuse. A server that ends a session makes its client emit `error`, and an
unhandled one would end the process and sign everyone out, so each client is
given an `error` listener as it connects (the pool's own listener does not hear
a checked-out client). The line is `portal.error` with step `pool`, the error
name and the SQLSTATE, never the message.

Sessions live in this process's memory, so a restart signs everyone out and
there is one instance per application. Build the data layer and the identity
verifier first (`pnpm install --frozen-lockfile && pnpm run build` in `portal/data` and
`services/identity` and `services/request-guard`): this package imports their
built output.

## Limiting sign-in per client

`GET /login` and the sign-in callback are the two routes a visitor with no
session can reach. Each application can limit them per client: 30 requests per
client per route per 60 seconds, then `429` with a `retry-after` header and the
body `RATE_LIMITED`. The count is made before a cookie is opened, the token
endpoint is called or a cookie is set. The two routes are counted separately,
so a flood of one cannot use up the other's allowance, and no other route is
counted.

The limiter is **off unless** `PORTAL_TRUSTED_PROXIES` (the tenant portal) or
`CONSOLE_TRUSTED_PROXIES` (the owner console) is set. Behind the edge the socket
peer is the edge itself, so without a list of proxies to believe every visitor
would share one bucket and the limit would lock everyone out. The value is a
comma-separated list of addresses and CIDR ranges: the address the edge connects
from. A malformed value, or one with no address in it, stops the process at
start. Set it to the edge's address only: a listed peer's `X-Forwarded-For` is
believed, and only its rightmost entry, which is the address the edge itself
saw. The contract is the one `services/demo-gate` documents, and the resolver is
the shared `services/request-guard`.

A client is its IPv6 /64, or its IPv4 address. A trusted peer that sends no
usable `X-Forwarded-For` is metered as one pooled client, so a broken edge
fails towards limited, not open. Each route's client ceiling remembers 10,000
clients; when full it forgets the oldest and admits the new one, so a flood of
addresses can restart another client's count but never refuses a visitor for
lack of room.

An IPv6 request is also counted against its /48, by the same
`resolveBroad` key `services/demo-gate` uses, in a second ceiling of 300 per
route per 60 seconds (ten times a client's). A /48 holds 65,536 /64s, so a
client rotating its /64 on every request would never reach 30; it reaches 300.
A request is refused if either ceiling refuses it, and is counted against
neither when it is refused, so a /64 already over its limit does not spend its
/48's. IPv4 has no broader key and is counted once, as before. The /48
ceiling remembers 100,000 /48s and, unlike the client ceiling, **refuses** a
new /48 when full of live windows (the fail-closed policy the demo gate uses)
rather than forgetting the oldest: forgetting would let a flood of /48s reset
exactly the counts this ceiling keeps. A full table therefore turns away new
IPv6 visitors for up to a window, and never IPv4 ones.

### Accepted: a full table of /48s refuses new IPv6 visitors

Filling the /48 table takes 100,000 distinct /48s inside one window, which an
attacker needs a /31 or more to do (a /32 holds 65,536). Until the window
passes, a new /48 sees `429`; /48s already counted and every IPv4 client are
unaffected. The alternative, forgetting the oldest, lets that same flood
restart a /48's count, which is the evasion the ceiling exists to stop. The
client ceiling still forgets the oldest /64 or IPv4 address when full; the
/48 ceiling bounds how many /64s one /48 can put there, so filling it takes
at least 34 /48s.

### Accepted: the sealing key is per process

The pending sign-in cookie is sealed under a key drawn when the process starts.
A deploy or restart therefore drops every pending sign-in (the visitor sees a
`400` and starts again), and several instances behind one address would not
accept each other's cookie. This is accepted: there is one process per
application, and a restart costs a ten-minute pending sign-in at worst. It is a
line to revisit if the portal ever runs more than one process or restarts often.

## Tests

```sh
nvm use && pnpm install --frozen-lockfile
PORTAL_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/postgres pnpm run coverage
```

The URL is a superuser on a throwaway cluster, as for `portal/data`.

### The browser journey

`pnpm run journey` walks the portal in a real Chromium (Playwright, an exact
version in `package.json`) against an HTTP test identity provider, with the
portal on the fixture database, and saves one full-page screenshot per screen
in `journey-screenshots/journey/` (`JOURNEY_SCREENSHOT_DIR` changes it). It
needs the same `PORTAL_TEST_DATABASE_URL` as the tests and a browser:
`pnpm exec playwright install chromium`. CI runs it in
`.github/workflows/portal-apps-journey.yml` and uploads the screenshots.

- The identity provider is `test/idpServer.ts`: discovery, keys, authorize
  (code with PKCE) and token, for a list of users given at start. It listens on
  loopback only, refuses to start under `NODE_ENV=production`, and is kept out
  of `dist`, the image and every import in `src/` by `test/testOnlyGuard.test.ts`.
- The walk is the list in `test/journey/steps/index.ts`. To add a screen, add
  one `JourneyStep` there: how to reach the screen, and the placeholder text it
  must show. A step whose screen lacks that text fails the walk and is saved as
  `<position>-<id>-FAILED.png`.

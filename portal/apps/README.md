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

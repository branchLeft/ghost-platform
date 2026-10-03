# identity

Zitadel as configuration. From a tenant list this service reconciles one
organisation per tenant, plus one project holding **two OIDC applications**
(the owner console and the tenant portal), and it verifies that a token belongs
to the application and the tenant presenting it. Design:
`ghost-platform-docs/19-try-it-now-design/08-portal.html` §02, §03, §11.

It touches no instance on its own: the reconciler runs only when an operator
points it at one.

## What it holds

- **Two clients, never one with role checks.** `owner-console` and
  `tenant-portal` are separate public PKCE clients with separate hostnames and
  redirect URIs. There is no client secret to create or custody.
- **Two roles in one project.** `owner` (the console) and `tenant-admin` (the
  portal). A tenant organisation is granted `tenant-admin` only, so `owner` is
  unobtainable for a tenant's user rather than merely unchecked. One tenant role
  serves MVP (one login per tenant); a second role is a new entry in
  `src/desired.ts` and one grant row, not a new shape.
- **One organisation per tenant**, named `tenant-<slug>`, plus the owner's own
  organisation. The tenant a request belongs to is the organisation its token
  carries, and nothing else.

## Hostnames are inputs

The console, the portal and the sign-in service each need their own name, and
the set is refused if any two match. No hostname is a constant here: Zitadel
fixes its external domain when an instance is first initialised, so the operator
decides them.

## Configuration

```json
{
  "hostnames": { "console": "...", "portal": "...", "identity": "..." },
  "tenants": [{ "slug": "alpha", "displayName": "ALPHA" }]
}
```

```bash
npm run build
ZITADEL_URL=https://<identity hostname> ZITADEL_TOKEN_FILE=/path/to/token \
  node dist/cli.js config.json outputs.json
```

The credential is read from a file, never argv or the environment. Output per
action is `created`, `unchanged` or `drift`; a second run against an unchanged
list writes nothing. **Drift is reported, never overwritten** (exit status 1): a
redirect URI or a grant that differs from the list was changed by someone.
Nothing is ever deleted; removing a tenant's organisation is a person's call.
`outputs.json` carries the organisation ids, project id and the two client ids,
none of which is a secret.

## Verifying a token

`verifyClaims` in `src/tokens.ts` runs after the JWT library has checked the
signature. It requires the sign-in service as issuer, the application's own
client id in the audience (and not its sibling's), a live expiry, the
application's role granted to the user's own organisation, and, for the
console, the owner organisation. Anything missing or mistyped is a refusal.

## Proof against real containers

`local/prove.sh` starts a throwaway Zitadel and PostgreSQL in Docker, reconciles
a two-tenant list twice, asserts the second run changed nothing and that each
tenant holds `tenant-admin` only, then removes the containers and volumes. It
needs Docker and creates nothing in any cloud.

**Not yet proven live:** that a user in one organisation cannot obtain a token
carrying another, and that a Zitadel-issued console token is refused by the
portal. Those are asserted here against modelled claims (`test/tokens.test.ts`),
not against tokens Zitadel issued.

## Tests

`npm run test:unit`; `npm run coverage` enforces the thresholds in
`vitest.config.ts`.

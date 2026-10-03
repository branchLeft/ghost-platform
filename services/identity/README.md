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

An application calls `createTokenVerifier(...).verify(rawBearerToken)` (the only
verdict-producing export of `src/index.ts`). It checks, in order: shape and size;
a **pinned signing algorithm** (RS256 only unless widened on purpose; `none`, any
HMAC and any elliptic curve have no verifier at all); a published key for the
token's `kid`, fetched from the issuer's `/oauth/v2/keys` (an unknown `kid`
triggers at most one refetch per interval; an unreachable key set is a refusal);
the signature; then the claims (`src/tokens.md`). Any failure returns a fixed
reason carrying nothing from the token.

The claims check requires the sign-in service as issuer, the application's own
client id in the audience **and as the `client_id` claim**, a live expiry, the
application's role granted to the user's own organisation, and an organisation
the application admits: `allowedOrgIds` is required, the owner's organisation for
the console and the reconciled tenant organisation ids (`outputs.json`) for the
portal. A role alone never admits, so an owner-organisation user holding
`tenant-admin` is refused by the portal. A tenant added after the portal started
is admitted only once the portal is given the refreshed list; an empty list
admits no one.

Read from a live instance: Zitadel lists *every* application of the project in
`aud`, so the audience alone cannot tell the portal's token from the console's;
`client_id` is what does. Each application must request the scopes
`openid`, `urn:zitadel:iam:org:projects:roles` and
`urn:zitadel:iam:user:resourceowner`, so the roles and the organisation claim are
present.

## Proof against real containers

`local/prove.sh` starts a throwaway Zitadel and PostgreSQL in Docker, then:
reconciles a two-tenant list and asserts the second run changed nothing and each
tenant holds `tenant-admin` only; signs real users in through the code-and-PKCE
flow; checks that Zitadel refuses organisation A's user a token for organisation
B; and checks that a real console token is refused by the portal check and the
reverse. Tokens are signature-verified against the instance's published keys.
It then removes the containers and volumes. It needs Docker and creates nothing
in any cloud.

## Known limits

- **Drift detection is partial.** The reconciler reads back, and reports drift
  on, only each application's redirect and post-logout URIs and each tenant
  grant's role set. A changed application type, authentication method, grant
  type, token type, role assertion or project check setting on something that
  already exists is not noticed. Creation sets them correctly; a later edit made
  by hand would pass unseen.
- Nothing is deleted: a tenant removed from the list keeps its organisation.

## Tests

`npm run test:unit`; `npm run coverage` enforces the thresholds in
`vitest.config.ts`.

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

The return address is `CALLBACK_PATH` (`/auth/callback`), exported from
`src/index.ts`: the reconciler registers it and both portal applications send
and serve it from that one constant, and `portal/apps/test/redirect.test.ts`
fails if the two differ. For a local run against a throwaway instance only,
`--local-dev-console-origin=http://localhost:PORT --local-dev-portal-origin=http://localhost:PORT`
registers plain-HTTP loopback addresses with Zitadel's development mode on. Only
the command line can ask for this (never the configuration file), both origins
must be loopback `http`, and every production application keeps development
mode off.

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
triggers at most one refetch per interval; the whole set is dropped and fetched
again once it is older than `maxCacheSeconds`, ten minutes by default, so a key
the issuer has withdrawn stops verifying; each fetch is abandoned after
`fetchTimeoutMs`, five seconds by default; an unreachable, slow or empty key set
is a refusal, never a fall back to the old keys);
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

Read from a live instance: Zitadel lists _every_ application of the project in
`aud`, so the audience alone cannot tell the portal's token from the console's;
`client_id` is what does. Each application must request the scopes
`openid`, `urn:zitadel:iam:org:projects:roles` and
`urn:zitadel:iam:user:resourceowner`, so the roles and the organisation claim are
present.

## Owner recovery

`src/recovery.ts` is the way back into the owner organisation when sign-in is
what is broken. It is a command run on the identity host, not a service:
nothing listens, and it never calls the portal or the console. It refuses
unless every condition holds: the sign-in address is a loopback address; the
recovery credential was staged within the age limit (30 minutes by default, 60
at most) as a plain file owned by the running user and closed to everyone else;
the output is a terminal; the credential and the user belong to the owner
organisation; and the audit file can be appended to. It writes an audit line
first and one at the end of every attempt, refused or not, and acts on nothing if
the first cannot be written. It checks and reads the staged credential through
one file descriptor opened without following a link, consumes the staged file,
and then unlocks or reactivates the user if needed and sets a one-time password
that must be changed at first sign-in. It does not reset a second factor.

Known limits: a process that has taken the loopback port while sign-in is down
would receive the credential; "single use" covers the staged file only, so the
token stays valid until it is rotated; and an organisation-owner token works
from anywhere that can reach the sign-in service.

The owner's procedure, and how the credential is stored and rotated, is in
`ghost-platform-docs`, `owner-console-recovery-runbook.md`.

## Outbound mail

The sign-in service sends every verification code, initialisation code,
password reset and invitation by email, and Zitadel sends none until it has a
mail provider. An optional `smtp` block in the configuration names one:

```json
{
  "smtp": {
    "host": "<mail host>",
    "port": 587,
    "senderAddress": "<sender>@<product domain>",
    "senderName": "<NAME>"
  }
}
```

```bash
ZITADEL_SMTP_PASSWORD_FILE=/path/to/password \
  ZITADEL_URL=... ZITADEL_TOKEN_FILE=... node dist/cli.js config.json outputs.json
```

- **The password is a file, never configuration.** It must be a plain file
  closed to other users, opened without following a link, printable ASCII on
  one line. The variable must be set when there is an `smtp` block and unset
  when there is not, so a password is never silently ignored.
- **The account name is the sender address.** The mail host accepts a sender
  only if it is the authenticated account's own address, so there is no separate
  user setting to get wrong.
- **TLS is required.** `tls` defaults on and the port must then be 587
  (STARTTLS). `tls: false` is accepted only for a single-label host such as
  `localhost`, which can never be a real mail host, so a plaintext submission to
  the internet cannot be written. The local proof is the only user of it.
- **A changed password replaces the provider.** Zitadel v4.19.4 accepts a
  password change on an existing provider and then keeps authenticating with the
  old one, which the local proof showed. So any change (the password included)
  creates a new provider, activates it, and then removes this reconciler's
  superseded ones. Zitadel never returns a stored password, so the change is
  noticed from a digest of every setting plus the password, written into the
  provider's description next to a `branchleft-managed` marker. A provider
  without the marker is never replaced or deleted: if one is active the run
  reports drift and changes nothing.
- **Sending is off the request path, but one hung mail host holds the queue.**
  The local proof shows Zitadel answers a request that sends mail in tens of
  milliseconds while the mail host hangs or refuses, and connects afterwards
  from its own background handler. It also showed that while one connection
  hangs, the codes behind it are not sent, and the ones in flight are lost when
  the connection ends; Zitadel does not retry. A person asks for a new code.

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

It also starts a small SMTP sink standing in for the mail host (`local/sink.mjs`)
and proves: the provider is configured and a second run writes nothing; a
verification code is delivered authenticated as, and sent as, the sender; a
rotated password is applied; and a request that sends mail is answered within a
few seconds while the mail host hangs or refuses, with a control showing the
hung host does hold a client that waits on it.

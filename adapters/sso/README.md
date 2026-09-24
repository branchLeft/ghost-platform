# Break-glass SSO adapter

The only code this platform adds to Ghost. It lets an operator holding a short-lived signed token open an Administrator session as **one account fixed per site**, with no standing password anywhere. Design: `ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html` §05 (B2 to B7).

`src/BreakGlassSSO.js` and `src/break-glass.js` are copied by the root `Dockerfile` into Ghost's internal adapter directory, `core/server/adapters/sso/`. They are never placed in the content directory, which a tenant can write to. The adapter is inert until a tenant's config selects it.

## Configuration

Ghost config, normally set as environment variables on the tenant's container:

| Env var | Meaning |
|---|---|
| `adapters__sso__active=BreakGlassSSO` | Selects this adapter. Unset, Ghost uses its own no-op adapter. |
| `adapters__sso__BreakGlassSSO__publicKey` | Ed25519 public key, base64 SPKI DER. Only the public half is ever on a tenant. |
| `adapters__sso__BreakGlassSSO__tenant` | This tenant's name. A token's `aud` must equal it. |
| `adapters__sso__BreakGlassSSO__supportIdentity` | The one account the adapter can produce: the support account on a paying site, the prospect's account on a demo. |

If any of the three is missing, is not a string, or the key is not an Ed25519 key, the adapter logs `break-glass: disabled (<reason>)` once at boot and refuses every token. The site boots regardless. Ghost parses environment values as JSON where it can, so a tenant name such as `2024` arrives as a number and disables break-glass. The renderer should never produce one.

## Token

```
base64url(JSON claims) "." base64url(Ed25519 signature over the first segment, as sent)
```

Claims: `sub` (must equal `supportIdentity`), `aud` (must equal `tenant`), `exp` (integer Unix seconds, in the future and at most 900 seconds away), `jti` (a unique string of 1 to 128 characters). The token arrives as the `bl_break_glass` query parameter on any `/ghost/` URL, up to 4096 characters.

Checks run in this order, all offline: signature, audience, expiry, subject, single use. The claims are not parsed until the signature has verified. Ghost then refuses the session on every request if the account is suspended.

Each `jti` is accepted once per Ghost process and remembered until its token expires. A used token is therefore worthless. This matters because Ghost writes the full request URL, token included, to its request log, and redirects the browser to `/ghost/#/?bl_break_glass=…`, so the token also stays in browser history.

Every decision is logged without the token itself: `break-glass: token accepted for the configured identity`, or `break-glass: token refused (<reason>)`. Ghost swallows adapter failures and shows the login page, so these lines are the only way to tell a refusal from an adapter that is not running.

## What Ghost's extension point does, and the traps in it

Ghost 6.55.0 constructs the adapter while building the admin app (`core/server/services/auth/session/index.js:76`) and validates configured adapters at boot (`adapter-manager` `init()`).

1. **It runs on the boot path.** A throw from the module load, the constructor, or a static `validate` stops Ghost starting, and readers are not served. The constructor cannot throw, there is no static `validate`, and the adapter requires only `node:crypto` and modules Ghost already resolves from its own directory.
2. **The obvious adapter lets a token log in as anybody.** An adapter that resolves the token's subject can mint an Owner session. This one checks the subject against its configuration and only ever looks up the configured identity.
3. **Suspension is Ghost's check, not the adapter's.** The adapter receives only `getByEmail` and `getOwner`, and `getByEmail` returns suspended users too. Ghost refuses a suspended account on every request, so a cookie issued while suspended is refused at once. See *Known residual* below.
4. **Failures are silent.** Ghost mounts the adapter with `callNextWithError: false`, so any error falls through to the login page.
5. **Load order.** Ghost looks in `node_modules`, then `core/server/adapters/`, then the content directory, and stops at the first hit. Shipping in `core/server/adapters/` means a planted content adapter with the same name is never loaded. The image test proves this.

## Known residual

A valid, unused token presented while the account is suspended makes Ghost create a verified session row for that account. The row is refused while the account stays suspended, but it becomes a live Administrator session the next time the account is un-suspended. Ghost's own un-suspend does not destroy existing sessions. Measured on 6.55.0. Single use and the 900-second lifetime cap narrow this to a stolen token that has not been used, presented after a revoke and before it expires. Closing it fully means the adapter must read the account's status, which the repository Ghost provides does not expose.

## Tests

```
npm ci && npm run coverage                       # unit, 90% threshold on every metric
docker build -t ghost-platform:ci ../..
IMAGE=ghost-platform:ci npm run test:image       # real Ghost 6.55.0 in Docker
```

The image test (`test/image/`) runs the built image: LLD-5 B3's rows (suspended, active, no token, tampered, forged, expired, other tenant, replay, revoke), B4 (a token naming the owner), B5 (boot and 200 with a malformed key and with each value missing), and a planted content adapter. Every refusal asserts both Ghost's 403 and the adapter's logged reason. `build.yml` runs it on every PR.

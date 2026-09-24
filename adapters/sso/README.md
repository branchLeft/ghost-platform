# Break-glass SSO adapter

The only code this platform adds to Ghost. It lets an operator holding a short-lived signed token open an Administrator session as **one account fixed per site**, with no standing password anywhere. Design: `ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html`, section 05, break-glass support access.

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

```text
base64url(JSON claims) "." base64url(Ed25519 signature over the first segment, as sent)
```

The claims are:

| Claim | Rule |
|---|---|
| `sub` | Must equal `supportIdentity`. |
| `aud` | Must equal `tenant`. |
| `iat` | Integer Unix seconds. No more than 60 seconds ahead of the tenant's clock, and not before this Ghost process started. |
| `exp` | Integer Unix seconds, in the future, after `iat`. At most 900 seconds after `iat` and after now. |
| `jti` | A string of 1 to 128 characters, unique and unpredictable. Use 128 random bits. |

The token arrives as the `bl_break_glass` query parameter on any `/ghost/` URL, up to 4096 characters.

**For the minter:** mint with a lifetime of 600 seconds or less. The 900-second cap has no margin for clock skew, so a token minted at exactly the cap is refused whenever the minter's clock runs ahead of the tenant's.

The checks run in this order, all offline: signature, audience, expiry and issue time, subject, then not already used. The claims are not parsed until the signature has verified. Ghost then refuses the session on every request while the account is suspended.

### Single use, and where it stops

A `jti` is recorded only after every check has passed and the account has been found active. A refused token therefore never uses up a legitimate `jti`. The record is kept in memory until the token expires, and an entry lost to a restart does not matter: a token issued before the current process started is refused outright. This costs one thing: a token minted shortly before a Ghost restart must be minted again. Nothing is persisted, because the content directory is tenant-writable and a file on the boot path is a boot risk.

Single use covers the request that opens the session. It does not make the URL safe to expose:

- **First fetch wins.** Whatever requests the URL first gets the session. That includes a link previewer in a chat tool, a mail security scanner, or a browser prefetch. The minter must deliver the URL through a channel that fetches nothing on the operator's behalf.
- **The token lands in logs and history.** Ghost writes the full request URL, token included, to its request log. Its 302 then sends the browser to `/ghost/#/?bl_break_glass=…`, so the token also stays in browser history. After use, the token is refused on every path the adapter sees.
- **The adapter only sees `/ghost/`.** A token sent to any other path, such as the site root, is written to Ghost's request log and is not seen, refused or consumed by the adapter. It stays usable until it expires. This is proven by an image test. Closing it would need something outside Ghost, such as the edge, because the adapter is mounted only on `/ghost/`.

Every decision is logged without the token itself: `break-glass: token accepted for the configured identity`, or `break-glass: token refused (<reason>)`. Ghost swallows adapter failures and shows the login page, so these lines are the only way to tell a refusal from an adapter that is not running.

## Turning it on for a tenant

**Never render `adapters__sso__active=BreakGlassSSO` for a tenant whose image predates this adapter.** Ghost cannot find the adapter and refuses to boot: `Unable to find sso adapter BreakGlassSSO in …`. The image pin bump has to land and deploy before the config that selects the adapter. The partial-triple rule works the other way round: a missing setting disables the adapter, and the site still boots.

## What Ghost's extension point does, and the traps in it

Ghost 6.55.0 constructs the adapter while building the admin app (`core/server/services/auth/session/index.js:76`) and validates configured adapters at boot (`adapter-manager` `init()`).

1. **It runs on the boot path.** A throw from the module load, the constructor, or a static `validate` stops Ghost starting, and readers are not served. The constructor cannot throw, there is no static `validate`, and the adapter requires only `node:crypto` and modules Ghost already resolves from its own directory.
2. **The obvious adapter lets a token log in as anybody.** An adapter that resolves the token's subject can mint an Owner session. This one checks the subject against its configuration and only ever looks up the configured identity.
3. **Ghost's lookup returns suspended accounts.** The adapter receives only `getByEmail` and `getOwner`, and `getByEmail` finds users of any status. Ghost refuses a suspended account's session on every request, but it would still create one. The adapter therefore checks the status itself (see below).
4. **Failures are silent.** Ghost mounts the adapter with `callNextWithError: false`, so any error falls through to the login page.
5. **Load order.** Ghost looks in `node_modules`, then `core/server/adapters/`, then the content directory, and stops at the first hit. Shipping in `core/server/adapters/` means a planted content adapter with the same name is never loaded. The image test proves this.

## The one read of Ghost's data: account status

Ghost's user lookup for SSO returns suspended accounts too. Left alone, Ghost would create a verified session for a suspended account, refuse it while the account stays suspended, and bring it back to life when the account is un-suspended. That can happen through the Staff screen, and for as long as Ghost keeps sessions (180 days by default). Nothing in Ghost destroys a user's sessions when their status changes, and a revoke cannot reach a session created after it.

So before returning the account, the adapter asks Ghost's `User` model whether the configured account, by id and email, is active now. It applies the same test Ghost's own session lookup uses (`status: 'active'`, which covers Ghost's active states). A suspended or otherwise inactive account is refused, with the reason `account not active`, and no session is created. A failed read is refused too (`account status unreadable`). This is a read, never a write. It is the only access the adapter has beyond the two lookups Ghost hands it, and the models are required at request time, never on the boot path. The image test proves that a token presented while suspended leaves no session row, and that nothing wakes when the account is un-suspended.

## Tests

```sh
npm ci && npm run coverage                       # unit, 90% threshold on every metric
docker build -t ghost-platform:ci ../..
IMAGE=ghost-platform:ci npm run test:image       # real Ghost 6.55.0 in Docker
```

The image test (`test/image/`) runs the built image through every case the design measured: a suspended and an active account, no token, a tampered, forged, expired or other-tenant token, a replay, a revoke, a token naming the owner, boot and 200 with a malformed key and with each value missing, and a planted content adapter. It also covers a replay across a Ghost restart, and a token sent to the site root. Every refusal asserts both Ghost's 403 and the adapter's logged reason. `build.yml` runs it on every PR.

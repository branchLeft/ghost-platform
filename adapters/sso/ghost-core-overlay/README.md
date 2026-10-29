# Ghost core overlay: session-from-token.js

The only Ghost-core file this platform patches: `core/server/services/auth/session/session-from-token.js`.
**No copy of Ghost's source is committed here.** The baseline is the file already inside the digest-pinned
Ghost image the root `Dockerfile` builds on, so a Ghost security release reaches us through that image's
Dependabot or release-watcher bump, never hidden behind a copy that keeps shipping the old bytes. What is
committed is our change only:

| File | What it is |
|---|---|
| `session-from-token.patch` | The unified diff of our one change, against Ghost's file. |
| `session-from-token.patched.sha256` | The SHA-256 of Ghost's file with the patch applied. |
| `apply-session-from-token-patch.sh` | Applies the patch to a directory holding Ghost's file and checks the result against the pin. The image build and the unit tests both run it. |
| `session-from-token.md` | What the patched function does and why. |

`derived/` (git-ignored) is where the unit tests build the patched file; it is never committed.

## How the image build uses it

The root `Dockerfile` runs `apply-session-from-token-patch.sh` on Ghost's file in the base image, in one
layer: `patch` is installed, used and removed there, and its output is hash-checked, so the tool never reaches
the image. The build **fails** in two distinct ways, each with its own message:

- `session-from-token.patch no longer applies cleanly`: a Ghost version bump changed lines the patch touches
  (the patch runs with no fuzz).
- `does not match session-from-token.patched.sha256`: the patch applied, but the result is not byte-for-byte the
  file the pin was taken from, so Ghost changed the file somewhere the patch does not look.

Either way re-deriving is a deliberate step (below), not automatic.

## What it changes

Upstream, the token-to-session middleware (`SessionFromToken`, used by `createSessionFromToken()` in
`core/server/services/auth/session/index.js`) calls `next()` immediately after `createSession(req, res, user)`
returns. `express-session`'s own `res.end` override then does two independent things when the response
ends: it flushes headers (including `Set-Cookie`) synchronously, and only afterwards asynchronously writes
the session to its store. A client that acts on the headers before that background write lands can have its
very next request refused, because the session row it authenticates against does not exist yet.

The patch adds one `await req.session.save()` (promisified) between `createSession()` and `next()`, so
the session is durably written before Ghost hands off to the response. A failed save calls `next(err)`
instead of falling through: the request must not look like a normal, unauthenticated response when a real,
accepted token's session failed to persist.

**A side effect, harmless at break-glass volume:** every login now writes the session row twice.
`createSessionForUser` calls `req.session.regenerate()` first, and `express-session`'s `Store.prototype.regenerate`
does not rewrap `save` or update the store's internal `originalId`/`savedHash` bookkeeping. So the explicit
`save()` the patch awaits never registers as "already saved" to `res.end`'s own end-of-response save, which
runs anyway. The second write is an `edit` of the same row the patch's save already created, not a second
row, and `Set-Cookie` is unchanged, so no client can observe it. Noted here only so a future reader instrumenting
`SessionStore.set` does not mistake the second write for a regression.

## Why

Measured on the pinned `ghost:6.55.0-alpine` image, driving real break-glass logins through the adapter:
sequential logins never hit the race (60/60), but concurrent logins did, worse under CPU contention, which
is exactly the condition an incident responder using break-glass is likely to be in. Full counts and the
before/after image-test proof are in `adapters/sso/test/image/break-glass.image.test.mjs` and the PR that
introduced this overlay.

## How it is tested

- Unit (`pnpm run coverage` in `adapters/sso/`): `test/unit/global-setup.mjs` takes Ghost's file out of the
  image the root `Dockerfile` names (`docker create` and `docker cp`; or from the path in
  `GHOST_SESSION_FROM_TOKEN_BASELINE`), applies the patch with the same script the build runs, and the tests
  exercise the patched output: the success and the save-error branch with a deferred fake `session.save`. The
  same suite runs the script against a Ghost file that differs and asserts it fails with the right message, and
  asserts this directory commits no JavaScript or licence copy.
- Image (`pnpm run test:image`, with `IMAGE` set): the built image's file hashes to the pin.

## Re-deriving it on a Ghost upgrade

A Ghost bump arrives as a change to the `FROM` line. If the build then fails with either message above:

1. Extract Ghost's new file from the new base image:
   ```sh
   cid=$(docker create ghost:<new-version>-alpine@sha256:<digest>)
   mkdir -p /tmp/a /tmp/b
   docker cp "$cid:/var/lib/ghost/current/core/server/services/auth/session/session-from-token.js" /tmp/a/session-from-token.js
   docker rm "$cid"
   cp /tmp/a/session-from-token.js /tmp/b/session-from-token.js
   ```
2. Re-apply the same one change to `/tmp/b/session-from-token.js` (await `req.session.save()` before `next()`,
   `next(err)` on a save failure). If Ghost's own session or save handling has changed shape, read the new
   upstream source rather than assuming the same fix still applies.
3. Regenerate the patch with the two paths labelled as the script expects:
   ```sh
   cd /tmp && diff -u --label a/session-from-token.js --label b/session-from-token.js a/session-from-token.js b/session-from-token.js > session-from-token.patch
   ```
   and copy it over `session-from-token.patch` here.
4. Write the new pin from the patched file:
   ```sh
   shasum -a 256 /tmp/b/session-from-token.js
   ```
   as `<hash>  session-from-token.js` in `session-from-token.patched.sha256`.
5. Run the unit suite (`pnpm run coverage` in `adapters/sso/`), rebuild the image, and run the break-glass image
   test, including the looped concurrent-login subtest.

## Baseline sources for the unit tests

The baseline comes from, in order:
  1. GHOST_SESSION_FROM_TOKEN_BASELINE, a path to the baseline file (for a
     caller that already has it out of the image);
  2. the image named by the root Dockerfile's one FROM line, through
     `docker create` and `docker cp`.
When neither works the run fails loudly: a skipped overlay test would read
as a pass.

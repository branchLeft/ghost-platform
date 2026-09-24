# Ghost core overlay: session-from-token.js

The only Ghost-core file this platform patches. Upstream `core/server/services/auth/session/session-from-token.js`
is MIT-licensed as part of Ghost; the base image ships no `LICENSE` file of its own, so `LICENSE-GHOST` in
this directory carries Ghost's copyright and permission notice, verified against Ghost's own upstream source.
This directory holds a full copy of that one file with a single change, copied into the image by the root
`Dockerfile` the same way `adapters/sso/src/*` is copied — a `COPY` onto the path Ghost already loads, not a
patch applied at build time. `session-from-token.upstream.js` alongside it is the pristine, unmodified form,
kept only as the baseline for the re-derivation diff below; a unit test pins its hash to
`session-from-token.upstream.sha256`, the same file the Dockerfile's build guard checks.

## What it changes

Upstream, the token-to-session middleware (`SessionFromToken`, used by `createSessionFromToken()` in
`core/server/services/auth/session/index.js`) calls `next()` immediately after `createSession(req, res, user)`
returns. `express-session`'s own `res.end` override then does two independent things when the response
ends: it flushes headers (including `Set-Cookie`) synchronously, and only afterwards asynchronously writes
the session to its store. A client that acts on the headers before that background write lands can have its
very next request refused, because the session row it authenticates against does not exist yet.

This overlay adds one `await req.session.save()` (promisified) between `createSession()` and `next()`, so
the session is durably written before Ghost hands off to the response. A failed save calls `next(err)`
instead of falling through — the request must not look like a normal, unauthenticated response when a real,
accepted token's session failed to persist.

**A side effect, harmless at break-glass volume:** every login now writes the session row twice.
`createSessionForUser` calls `req.session.regenerate()` first, and `express-session`'s `Store.prototype.regenerate`
does not rewrap `save` or update the store's internal `originalId`/`savedHash` bookkeeping. So the explicit
`save()` this overlay awaits never registers as "already saved" to `res.end`'s own end-of-response save, which
runs anyway. The second write is an `edit` of the same row this overlay's save already created, not a second
row, and `Set-Cookie` is unchanged, so no client can observe it. Noted here only so a future reader instrumenting
`SessionStore.set` does not mistake the second write for a regression.

## Why

Measured on the pinned `ghost:6.55.0-alpine` image, driving real break-glass logins through the adapter:
sequential logins never hit the race (60/60), but concurrent logins did — worse under CPU contention, which
is exactly the condition an incident responder using break-glass is likely to be in. Full counts and the
before/after image-test proof are in `adapters/sso/test/image/break-glass.image.test.mjs` and the PR that
introduced this file.

## Re-deriving it on a Ghost upgrade

The Dockerfile checks `session-from-token.upstream.sha256` against the file at this path inside the base
image **before** copying this overlay over it, and fails the build on a mismatch. A Ghost version bump that
changes this file's upstream bytes must fail the build, not silently ship a patch derived from an older Ghost.

To re-derive after a Ghost upgrade:

1. Pull the new base image and extract the current upstream file:
   ```sh
   cid=$(docker create ghost:<new-version>-alpine@sha256:<digest>)
   docker cp "$cid:/var/lib/ghost/current/core/server/services/auth/session/session-from-token.js" /tmp/upstream.js
   docker rm "$cid"
   ```
2. Diff `/tmp/upstream.js` against `session-from-token.upstream.js` in this directory -- the pristine,
   unmodified copy the previous re-derivation pinned, not the patched `session-from-token.js` with the
   `branchLeft:` block removed. Deleting only that block from the patched file is not the same as the
   original: the patch also moves `next()` out of the `try` and adds a `return;` to the `catch`, so a diff
   against the patched file omits those two changes too.
3. Overwrite `session-from-token.upstream.js` in this directory with `/tmp/upstream.js` -- it must always be
   the untouched file, never the patched one.
4. Re-apply the same one change -- await `req.session.save()` before `next()`, `next(err)` on a save failure
   -- onto the new upstream file, and overwrite `session-from-token.js` here with the result.
5. Recompute the guard hash from the *new* upstream file (not the patched one):
   ```sh
   shasum -a 256 /tmp/upstream.js
   ```
   and write `<hash>  session-from-token.js` into `session-from-token.upstream.sha256`.
6. Run the unit suite (`npm run coverage` in `adapters/sso/`) -- it asserts `session-from-token.upstream.js`
   hashes to the pin you just wrote, and exercises both the success and the save-error branch of the patched
   handler with a deferred fake `session.save`, so a regression here is caught without a container.
7. Rebuild the image; the break-glass image test must pass, including the looped concurrent-login subtest and
   the check that the built image's copy of the file hashes to this directory's overlay. If Ghost's own
   session/save handling has changed shape, re-read this file's upstream source rather than assuming the
   same one-line fix still applies.

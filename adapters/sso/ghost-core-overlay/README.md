# Ghost core overlay: session-from-token.js

The only Ghost-core file this platform patches. Upstream `core/server/services/auth/session/session-from-token.js`
is MIT-licensed as part of Ghost (see Ghost's own `LICENSE`); this directory holds a full copy of that
one file with a single change, copied into the image by the root `Dockerfile` the same way
`adapters/sso/src/*` is copied — a `COPY` onto the path Ghost already loads, not a patch applied at
build time.

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
2. Diff `/tmp/upstream.js` against this directory's previous `session-from-token.js` (its pre-patch form is
   the tracked history of this file minus the `branchLeft:` block) to see what Ghost changed.
3. Re-apply the same one change -- await `req.session.save()` before `next()`, `next(err)` on a save failure
   -- onto the new upstream file, and overwrite `session-from-token.js` here with the result.
4. Recompute the guard hash from the *new* upstream file (not the patched one):
   ```sh
   shasum -a 256 /tmp/upstream.js
   ```
   and write `<hash>  session-from-token.js` into `session-from-token.upstream.sha256`.
5. Rebuild the image; the break-glass image test's concurrent-login subtest must pass. If Ghost's own
   session/save handling has changed shape, re-read this file's upstream source rather than assuming the
   same one-line fix still applies.

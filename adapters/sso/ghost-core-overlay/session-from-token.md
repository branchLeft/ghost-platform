# session-from-token.js

## SessionFromToken

Returns a connect middleware function which exchanges a token for a session.

| Parameter | Type | Meaning |
|---|---|---|
| `deps.getTokenFromRequest` | `(req: Req) => Promise<Token>` | Reads the token from the request. |
| `deps.getLookupFromToken` | `(token: Token) => Promise<Lookup>` | Turns the token into a lookup value. |
| `deps.findUserByLookup` | `(lookup: Lookup) => Promise<User>` | Resolves the lookup to a user. |
| `deps.createSession` | `(req: Req, res: Res, user: User) => Promise<void>` | Creates the session for that user. |
| `deps.callNextWithError` | `boolean` | Whether `next` should be called with an error or just pass through. |

Returns a `RequestHandler`.

## Session save is awaited before next()

express-session's own `res.end` override flushes response headers —
including `Set-Cookie` — synchronously, then writes the session to its store
asynchronously in the background (see express-session's `index.js`). A
client that acts on the headers before that write lands (any redirect- or
page-follower, not just a test) can be refused on its very next request,
because the session row it is authenticating against does not exist yet.

Awaiting the save here, before `next()` hands off to the response, closes
that window: by the time headers can reach a client, the session is already
durable. A failed save must not hand off to a response that looks like a
normal, if unauthenticated, page — the caller already holds an accepted
token for a real user, so silence here would read as a working login that
silently is not one.

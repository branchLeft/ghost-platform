module.exports = SessionFromToken;

/**
 * @typedef {object} User
 * @prop {string} id
 */

/**
 * @typedef {import('express').Request} Req
 * @typedef {import('express').Response} Res
 * @typedef {import('express').NextFunction} Next
 * @typedef {import('express').RequestHandler} RequestHandler
 */

/**
 * Returns a connect middleware function which exchanges a token for a session
 *
 * @template Token
 * @template Lookup
 *
 * @param { object } deps
 * @param { (req: Req) => Promise<Token> } deps.getTokenFromRequest
 * @param { (token: Token) => Promise<Lookup> } deps.getLookupFromToken
 * @param { (lookup: Lookup) => Promise<User> } deps.findUserByLookup
 * @param { (req: Req, res: Res, user: User) => Promise<void> } deps.createSession
 * @param { boolean } deps.callNextWithError - Whether next should be call with an error or just pass through
 *
 * @returns {RequestHandler}
 */
function SessionFromToken({
    getTokenFromRequest,
    getLookupFromToken,
    findUserByLookup,
    createSession,
    callNextWithError
}) {
    /**
     * @param {Req} req
     * @param {Res} res
     * @param {Next} next
     * @returns {Promise<void>}
     */
    async function handler(req, res, next) {
        try {
            const token = await getTokenFromRequest(req);
            if (!token) {
                return next();
            }
            const email = await getLookupFromToken(token);
            if (!email) {
                return next();
            }
            const user = await findUserByLookup(email);
            if (!user) {
                return next();
            }
            await createSession(req, res, user);
        } catch (err) {
            if (callNextWithError) {
                next(err);
            } else {
                next();
            }
            return;
        }

        // branchLeft: express-session's own `res.end` override flushes response
        // headers -- including `Set-Cookie` -- synchronously, then writes the
        // session to its store asynchronously in the background (see
        // express-session's index.js). A client that acts on the headers
        // before that write lands (any redirect- or page-follower, not just a
        // test) can be refused on its very next request, because the session
        // row it is authenticating against does not exist yet. Awaiting the
        // save here, before `next()` hands off to the response, closes that
        // window: by the time headers can reach a client, the session is
        // already durable. A failed save must not hand off to a response that
        // looks like a normal, if unauthenticated, page -- the caller already
        // holds an accepted token for a real user, so silence here would read
        // as a working login that silently is not one.
        try {
            await new Promise((resolve, reject) => {
                req.session.save((err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        } catch (err) {
            next(err);
            return;
        }

        next();
    }

    return handler;
}

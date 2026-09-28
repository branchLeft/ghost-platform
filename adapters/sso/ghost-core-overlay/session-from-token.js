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
 * Returns a connect middleware function which exchanges a token for a session.
 * See session-from-token.md#sessionfromtoken for the parameter and return shapes.
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

        // The session save is awaited before next(): express-session flushes
        // Set-Cookie before its async store write lands, so a client acting on
        // the cookie first would be refused. See
        // session-from-token.md#session-save-is-awaited-before-next.
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

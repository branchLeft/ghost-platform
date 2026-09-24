'use strict';

const crypto = require('node:crypto');

const QUERY_PARAM = 'bl_break_glass';
const MAX_TOKEN_LENGTH = 4096;
const MAX_JTI_LENGTH = 128;
// A token is carried from the broker to a browser, so minutes are enough. The
// cap bounds a mis-minted token, which would otherwise be good until its exp.
const MAX_TTL_SECONDS = 900;
// Allowance for a minter whose clock runs ahead of the tenant's.
const MAX_ISSUE_SKEW_SECONDS = 60;
// Bounds memory against a flood of validly signed tokens. With the lifetime cap
// above this is far beyond any real use; when full, new tokens are refused
// rather than old entries evicted, because evicting would re-enable a replay.
const MAX_CONSUMED = 10000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const noopLogger = Object.freeze({ info() {}, warn() {} });

function safeLog(logger, level, message) {
  try {
    logger[level](message);
  } catch {
    // Logging must never be the reason a request or a boot fails.
  }
}

/**
 * Reads the three settings. Never throws: anything malformed or missing
 * disables break-glass, and the reason is returned for the log.
 */
function parseConfig(config) {
  const disabled = (reason) => ({ key: null, tenant: null, identity: null, reason });
  try {
    if (!config || typeof config !== 'object') {
      return disabled('no configuration');
    }
    const { publicKey, tenant, supportIdentity } = config;
    // Ghost reads env config with parseValues, so a value that looks like a
    // number or boolean arrives as one. Only strings are accepted.
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      return disabled('publicKey missing');
    }
    if (typeof tenant !== 'string' || tenant.length === 0) {
      return disabled('tenant missing');
    }
    if (typeof supportIdentity !== 'string' || supportIdentity.length === 0) {
      return disabled('supportIdentity missing');
    }
    if (!BASE64.test(publicKey)) {
      return disabled('publicKey is not base64');
    }
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') {
      return disabled('publicKey is not ed25519');
    }
    return { key, tenant, identity: supportIdentity, reason: null };
  } catch {
    return disabled('publicKey is malformed');
  }
}

/**
 * Builds the adapter class over Ghost's SSO base class. Kept apart from the
 * entry file so the logic is testable without Ghost's module tree.
 */
function defineBreakGlassSSO(SSOBase, { logger, now = Date.now, isAccountActive } = {}) {
  const log =
    logger && typeof logger.warn === 'function' && typeof logger.info === 'function'
      ? logger
      : noopLogger;
  // Only lookups this adapter produced are honoured by getUserForIdentity.
  const issued = new WeakSet();

  return class BreakGlassSSO extends SSOBase {
    #key;
    #tenant;
    #identity;
    #startSeconds;
    #consumed = new Map();

    // Runs on Ghost's boot path: a throw here stops the site serving.
    constructor(config) {
      super();
      const parsed = parseConfig(config);
      this.#key = parsed.key;
      this.#tenant = parsed.tenant;
      this.#identity = parsed.identity;
      // The used-token list is memory only, so it is empty after a restart. A
      // token issued before this process started may already have been used,
      // and is refused. Unreadable clock: refuse everything, never throw.
      try {
        this.#startSeconds = Math.floor(now() / 1000);
      } catch {
        this.#startSeconds = Infinity;
      }
      if (parsed.reason) {
        safeLog(
          log,
          'warn',
          `break-glass: disabled (${parsed.reason}); every token will be refused`
        );
      }
    }

    #refuse(reason) {
      safeLog(log, 'warn', `break-glass: token refused (${reason})`);
      return null;
    }

    #sweep(nowSeconds) {
      for (const [seen, seenExp] of this.#consumed) {
        if (seenExp <= nowSeconds) {
          this.#consumed.delete(seen);
        }
      }
    }

    async getRequestCredentials(req) {
      try {
        const value = req && req.query ? req.query[QUERY_PARAM] : undefined;
        if (value === undefined) {
          return null;
        }
        if (typeof value !== 'string' || value.length === 0) {
          return this.#refuse('malformed');
        }
        if (value.length > MAX_TOKEN_LENGTH) {
          return this.#refuse('oversize');
        }
        return value;
      } catch {
        return this.#refuse('unreadable request');
      }
    }

    // Verifies the token and returns a lookup for getUserForIdentity. Nothing
    // is recorded here: a refused token must never use up a legitimate jti,
    // and the jti is only consumed once the account has been found.
    async getIdentityFromCredentials(token) {
      try {
        if (!this.#key) {
          return this.#refuse('disabled');
        }
        if (typeof token !== 'string') {
          return this.#refuse('malformed');
        }
        const parts = token.split('.');
        if (parts.length !== 2 || !BASE64URL.test(parts[0]) || !BASE64URL.test(parts[1])) {
          return this.#refuse('malformed');
        }
        const [body, signature] = parts;
        const signatureBytes = Buffer.from(signature, 'base64url');
        if (signatureBytes.length !== 64) {
          return this.#refuse('malformed');
        }
        // The signature covers the encoded body exactly as sent, so the
        // claims are never parsed until they are known to be ours.
        if (!crypto.verify(null, Buffer.from(body, 'ascii'), this.#key, signatureBytes)) {
          return this.#refuse('signature');
        }
        let claims;
        try {
          claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        } catch {
          return this.#refuse('malformed claims');
        }
        if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
          return this.#refuse('malformed claims');
        }
        if (claims.aud !== this.#tenant) {
          return this.#refuse('audience');
        }
        const nowSeconds = now() / 1000;
        if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
          return this.#refuse('expired');
        }
        if (!Number.isSafeInteger(claims.iat) || claims.iat >= claims.exp) {
          return this.#refuse('issued-at');
        }
        if (
          claims.exp - claims.iat > MAX_TTL_SECONDS ||
          claims.exp - nowSeconds > MAX_TTL_SECONDS
        ) {
          return this.#refuse('lifetime too long');
        }
        if (claims.iat > nowSeconds + MAX_ISSUE_SKEW_SECONDS) {
          return this.#refuse('issued in the future');
        }
        if (claims.iat < this.#startSeconds) {
          return this.#refuse('issued before this process started');
        }
        // The token's subject is checked, never used: the only account
        // this adapter can produce is the one named in its own config.
        if (claims.sub !== this.#identity) {
          return this.#refuse('subject');
        }
        if (
          typeof claims.jti !== 'string' ||
          claims.jti.length === 0 ||
          claims.jti.length > MAX_JTI_LENGTH
        ) {
          return this.#refuse('jti');
        }
        this.#sweep(nowSeconds);
        if (this.#consumed.has(claims.jti)) {
          return this.#refuse('replay');
        }
        const lookup = Object.freeze({
          identity: this.#identity,
          jti: claims.jti,
          exp: claims.exp,
        });
        issued.add(lookup);
        return lookup;
      } catch {
        return this.#refuse('verification error');
      }
    }

    async getUserForIdentity(lookup) {
      try {
        if (!this.#identity || !issued.has(lookup) || lookup.identity !== this.#identity) {
          return null;
        }
        const user = await this.getUserByEmail(this.#identity);
        if (!user) {
          return this.#refuse('no such account');
        }
        // Ghost's lookup returns suspended accounts too, and Ghost would create
        // a session that wakes up when the account is un-suspended. So the
        // account must be active now; anything unreadable is a refusal.
        let active = false;
        try {
          active =
            typeof isAccountActive === 'function' &&
            (await isAccountActive(this.#identity, user.id)) === true;
        } catch {
          return this.#refuse('account status unreadable');
        }
        if (!active) {
          return this.#refuse('account not active');
        }
        // Synchronous from here to the set, so concurrent requests carrying
        // the same token cannot both pass.
        this.#sweep(now() / 1000);
        if (this.#consumed.has(lookup.jti)) {
          return this.#refuse('replay');
        }
        if (this.#consumed.size >= MAX_CONSUMED) {
          return this.#refuse('replay cache full');
        }
        this.#consumed.set(lookup.jti, lookup.exp);
        safeLog(log, 'info', 'break-glass: token accepted for the configured identity');
        return user;
      } catch {
        return null;
      }
    }
  };
}

module.exports = {
  defineBreakGlassSSO,
  parseConfig,
  QUERY_PARAM,
  MAX_TTL_SECONDS,
  MAX_ISSUE_SKEW_SECONDS,
  MAX_TOKEN_LENGTH,
  MAX_CONSUMED,
};

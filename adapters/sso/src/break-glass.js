'use strict';

const crypto = require('node:crypto');

const QUERY_PARAM = 'bl_break_glass';
const MAX_TOKEN_LENGTH = 4096;
const MAX_JTI_LENGTH = 128;
// A token is carried from the broker to a browser, so minutes are enough. The
// cap bounds a mis-minted token, which would otherwise be good until its exp.
const MAX_TTL_SECONDS = 900;
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
function defineBreakGlassSSO(SSOBase, { logger, now = Date.now } = {}) {
  const log =
    logger && typeof logger.warn === 'function' && typeof logger.info === 'function'
      ? logger
      : noopLogger;

  return class BreakGlassSSO extends SSOBase {
    #key;
    #tenant;
    #identity;
    #consumed = new Map();

    // Runs on Ghost's boot path: a throw here stops the site serving.
    constructor(config) {
      super();
      const parsed = parseConfig(config);
      this.#key = parsed.key;
      this.#tenant = parsed.tenant;
      this.#identity = parsed.identity;
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

    #consume(jti, exp, nowSeconds) {
      for (const [seen, seenExp] of this.#consumed) {
        if (seenExp <= nowSeconds) {
          this.#consumed.delete(seen);
        }
      }
      if (this.#consumed.has(jti)) {
        return 'replay';
      }
      if (this.#consumed.size >= MAX_CONSUMED) {
        return 'replay cache full';
      }
      this.#consumed.set(jti, exp);
      return null;
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
        if (claims.exp - nowSeconds > MAX_TTL_SECONDS) {
          return this.#refuse('lifetime too long');
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
        const consumed = this.#consume(claims.jti, claims.exp, nowSeconds);
        if (consumed) {
          return this.#refuse(consumed);
        }
        safeLog(log, 'info', 'break-glass: token accepted for the configured identity');
        return this.#identity;
      } catch {
        return this.#refuse('verification error');
      }
    }

    async getUserForIdentity(identity) {
      try {
        if (!this.#identity || identity !== this.#identity) {
          return null;
        }
        const user = await this.getUserByEmail(this.#identity);
        return user || null;
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
  MAX_TOKEN_LENGTH,
  MAX_CONSUMED,
};

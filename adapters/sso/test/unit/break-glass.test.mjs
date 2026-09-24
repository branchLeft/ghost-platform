import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { claimsFor, generateKeyPair, mint, signRaw } from '../helpers/token.mjs';

const require = createRequire(import.meta.url);
const { SSOBase } = require('@tryghost/adapter-base-sso');
const {
  defineBreakGlassSSO,
  parseConfig,
  QUERY_PARAM,
  MAX_TTL_SECONDS,
  MAX_TOKEN_LENGTH,
  MAX_CONSUMED,
} = require('../../src/break-glass.js');
const { default: EntryBreakGlassSSO } = await import('../../src/BreakGlassSSO.js');

const TENANT = 'tenant-zero';
const SUPPORT = 'support@platform.example';
const OWNER = 'owner@example.com';
const NOW_MS = Date.UTC(2026, 8, 24, 12, 0, 0);

const tenantKey = generateKeyPair();
const otherKey = generateKeyPair();

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeAdapter({ config, logger = makeLogger(), now = () => NOW_MS, users } = {}) {
  const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { logger, now });
  const adapter = new BreakGlassSSO(
    config ?? { publicKey: tenantKey.publicKeyBase64, tenant: TENANT, supportIdentity: SUPPORT }
  );
  const repository = users ?? {
    getByEmail: vi.fn(async (email) => ({ id: `id-of-${email}`, email })),
    getOwner: vi.fn(async () => ({ id: 'owner-id', email: OWNER })),
  };
  adapter.setUserRepository(repository);
  return { adapter, logger, repository };
}

function token(overrides = {}, key = tenantKey.privateKey) {
  return mint(key, { ...claimsFor({ sub: SUPPORT, aud: TENANT, nowMs: NOW_MS }), ...overrides });
}

function refusalReasons(logger) {
  return logger.warn.mock.calls.map(([message]) => message);
}

describe('parseConfig', () => {
  it('accepts a complete triple with an Ed25519 SPKI key', () => {
    const parsed = parseConfig({
      publicKey: tenantKey.publicKeyBase64,
      tenant: TENANT,
      supportIdentity: SUPPORT,
    });
    expect(parsed.reason).toBeNull();
    expect(parsed.key.asymmetricKeyType).toBe('ed25519');
    expect(parsed.tenant).toBe(TENANT);
    expect(parsed.identity).toBe(SUPPORT);
  });

  it.each([
    [undefined, 'no configuration'],
    [null, 'no configuration'],
    ['a string', 'no configuration'],
    [{ tenant: TENANT, supportIdentity: SUPPORT }, 'publicKey missing'],
    [{ publicKey: '', tenant: TENANT, supportIdentity: SUPPORT }, 'publicKey missing'],
    [{ publicKey: 12345, tenant: TENANT, supportIdentity: SUPPORT }, 'publicKey missing'],
    [{ publicKey: 'AAAA', supportIdentity: SUPPORT }, 'tenant missing'],
    // Ghost parses env values, so a numeric tenant name arrives as a number.
    [{ publicKey: 'AAAA', tenant: 2024, supportIdentity: SUPPORT }, 'tenant missing'],
    [{ publicKey: 'AAAA', tenant: TENANT }, 'supportIdentity missing'],
    [{ publicKey: 'AAAA', tenant: TENANT, supportIdentity: true }, 'supportIdentity missing'],
    [
      { publicKey: 'not base64!', tenant: TENANT, supportIdentity: SUPPORT },
      'publicKey is not base64',
    ],
    [{ publicKey: 'AAAAAAAA', tenant: TENANT, supportIdentity: SUPPORT }, 'publicKey is malformed'],
  ])('disables break-glass for %j (%s)', (config, reason) => {
    const parsed = parseConfig(config);
    expect(parsed).toEqual({ key: null, tenant: null, identity: null, reason });
  });

  it('refuses a well-formed key of another algorithm', () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(parseConfig({ publicKey: der, tenant: TENANT, supportIdentity: SUPPORT }).reason).toBe(
      'publicKey is not ed25519'
    );
  });

  it('never throws, even when reading the config throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      }
    );
    expect(parseConfig(hostile).key).toBeNull();
  });
});

describe('construction on the boot path', () => {
  it.each([
    ['no config', undefined],
    ['malformed key', { publicKey: 'AAAAAAAA', tenant: TENANT, supportIdentity: SUPPORT }],
    ['missing publicKey', { tenant: TENANT, supportIdentity: SUPPORT }],
    ['missing tenant', { publicKey: tenantKey.publicKeyBase64, supportIdentity: SUPPORT }],
    ['missing supportIdentity', { publicKey: tenantKey.publicKeyBase64, tenant: TENANT }],
  ])('constructs without throwing and refuses every token: %s', async (_name, config) => {
    const logger = makeLogger();
    const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { logger, now: () => NOW_MS });
    const adapter = new BreakGlassSSO(config);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^break-glass: disabled \(/));
    expect(await adapter.getIdentityFromCredentials(token())).toBeNull();
    expect(refusalReasons(logger)).toContain('break-glass: token refused (disabled)');
    expect(await adapter.getUserForIdentity(SUPPORT)).toBeNull();
  });

  it('survives a logger that throws', async () => {
    const logger = {
      info() {
        throw new Error('log down');
      },
      warn() {
        throw new Error('log down');
      },
    };
    const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { logger });
    const adapter = new BreakGlassSSO(undefined);
    expect(await adapter.getIdentityFromCredentials('x.y')).toBeNull();
  });

  it('falls back to a silent logger when the one given is incomplete, and to Date.now by default', async () => {
    const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { logger: { warn() {} } });
    const adapter = new BreakGlassSSO({
      publicKey: tenantKey.publicKeyBase64,
      tenant: TENANT,
      supportIdentity: SUPPORT,
    });
    const live = mint(tenantKey.privateKey, claimsFor({ sub: SUPPORT, aud: TENANT }));
    expect(await adapter.getIdentityFromCredentials(live)).toBe(SUPPORT);
    expect(new (defineBreakGlassSSO(SSOBase))(undefined)).toBeInstanceOf(SSOBase);
  });

  it('declares no static validate, which Ghost would call at boot', () => {
    expect(EntryBreakGlassSSO.validate).toBeUndefined();
    expect(defineBreakGlassSSO(SSOBase).validate).toBeUndefined();
  });
});

describe('the shipped entry file', () => {
  it("is a class extending Ghost's SSO base with the three required methods", () => {
    const adapter = new EntryBreakGlassSSO({});
    expect(adapter).toBeInstanceOf(SSOBase);
    expect(EntryBreakGlassSSO.name).toBe('BreakGlassSSO');
    for (const fn of adapter.requiredFns) {
      expect(typeof adapter[fn]).toBe('function');
    }
  });
});

describe('getRequestCredentials', () => {
  it(`reads the ${QUERY_PARAM} query parameter`, async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.getRequestCredentials({ query: { [QUERY_PARAM]: 'abc.def' } })).toBe(
      'abc.def'
    );
  });

  it('returns null quietly when there is no token', async () => {
    const { adapter, logger } = makeAdapter();
    expect(await adapter.getRequestCredentials({ query: {} })).toBeNull();
    expect(await adapter.getRequestCredentials({})).toBeNull();
    expect(await adapter.getRequestCredentials(undefined)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an array', ['a', 'b'], 'malformed'],
    ['an object', { a: 1 }, 'malformed'],
    ['an empty string', '', 'malformed'],
    ['an oversized value', 'a'.repeat(MAX_TOKEN_LENGTH + 1), 'oversize'],
  ])('refuses %s', async (_name, value, reason) => {
    const { adapter, logger } = makeAdapter();
    expect(await adapter.getRequestCredentials({ query: { [QUERY_PARAM]: value } })).toBeNull();
    expect(refusalReasons(logger)).toContain(`break-glass: token refused (${reason})`);
  });

  it('refuses when the request cannot be read', async () => {
    const { adapter, logger } = makeAdapter();
    const req = {
      get query() {
        throw new Error('bad query string');
      },
    };
    expect(await adapter.getRequestCredentials(req)).toBeNull();
    expect(refusalReasons(logger)).toContain('break-glass: token refused (unreadable request)');
  });
});

describe('getIdentityFromCredentials', () => {
  it('returns the configured identity for a valid token, and logs the acceptance', async () => {
    const { adapter, logger } = makeAdapter();
    expect(await adapter.getIdentityFromCredentials(token())).toBe(SUPPORT);
    expect(logger.info).toHaveBeenCalledWith(
      'break-glass: token accepted for the configured identity'
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  const bodyOf = (t) => t.split('.')[0];
  const sigOf = (t) => t.split('.')[1];
  // A middle character: the last one of a base64url signature carries padding
  // bits, and changing only those decodes to the same signature.
  const flipMiddleChar = (s) => s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21);

  it.each([
    ['a non-string', () => 42, 'malformed'],
    ['one segment', () => bodyOf(token()), 'malformed'],
    ['three segments', () => `${token()}.x`, 'malformed'],
    ['characters outside base64url', () => `${bodyOf(token())}.${sigOf(token())}+`, 'malformed'],
    ['a short signature', () => `${bodyOf(token())}.AAAA`, 'malformed'],
    ['a forged signature from another key', () => token({}, otherKey.privateKey), 'signature'],
    [
      'a tampered signature',
      () => `${bodyOf(token())}.${flipMiddleChar(sigOf(token()))}`,
      'signature',
    ],
    [
      'claims rewritten under the original signature',
      () => {
        const original = token();
        const rewritten = Buffer.from(
          JSON.stringify({ ...claimsFor({ sub: OWNER, aud: TENANT, nowMs: NOW_MS }) })
        ).toString('base64url');
        return `${rewritten}.${sigOf(original)}`;
      },
      'signature',
    ],
    ['signed non-JSON', () => signRaw(tenantKey.privateKey, 'not json'), 'malformed claims'],
    ['signed JSON null', () => signRaw(tenantKey.privateKey, 'null'), 'malformed claims'],
    ['a signed JSON array', () => signRaw(tenantKey.privateKey, '[1,2]'), 'malformed claims'],
    ['a signed JSON number', () => signRaw(tenantKey.privateKey, '7'), 'malformed claims'],
    ['another tenant as audience', () => token({ aud: 'tenant-one' }), 'audience'],
    ['no audience', () => token({ aud: undefined }), 'audience'],
    ['an expired token', () => token({ exp: NOW_MS / 1000 - 60 }), 'expired'],
    ['exp equal to now', () => token({ exp: NOW_MS / 1000 }), 'expired'],
    ['a fractional exp', () => token({ exp: NOW_MS / 1000 + 60.5 }), 'expired'],
    ['a string exp', () => token({ exp: String(NOW_MS / 1000 + 60) }), 'expired'],
    ['no exp', () => token({ exp: undefined }), 'expired'],
    [
      'a lifetime over the cap',
      () => token({ exp: NOW_MS / 1000 + MAX_TTL_SECONDS + 1 }),
      'lifetime too long',
    ],
    ["the tenant owner's address as subject", () => token({ sub: OWNER }), 'subject'],
    ['no subject', () => token({ sub: undefined }), 'subject'],
    ['a subject differing only in case', () => token({ sub: SUPPORT.toUpperCase() }), 'subject'],
    ['no jti', () => token({ jti: undefined }), 'jti'],
    ['an empty jti', () => token({ jti: '' }), 'jti'],
    ['a numeric jti', () => token({ jti: 7 }), 'jti'],
    ['an oversized jti', () => token({ jti: 'j'.repeat(129) }), 'jti'],
  ])('refuses %s', async (_name, build, reason) => {
    const { adapter, logger } = makeAdapter();
    expect(await adapter.getIdentityFromCredentials(build())).toBeNull();
    expect(refusalReasons(logger)).toEqual([`break-glass: token refused (${reason})`]);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('accepts a lifetime exactly at the cap', async () => {
    const { adapter } = makeAdapter();
    expect(
      await adapter.getIdentityFromCredentials(token({ exp: NOW_MS / 1000 + MAX_TTL_SECONDS }))
    ).toBe(SUPPORT);
  });

  it('refuses a replay of a token already used', async () => {
    const { adapter, logger } = makeAdapter();
    const once = token();
    expect(await adapter.getIdentityFromCredentials(once)).toBe(SUPPORT);
    expect(await adapter.getIdentityFromCredentials(once)).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (replay)']);
  });

  it('forgets a used jti only once its token has expired', async () => {
    let nowMs = NOW_MS;
    const { adapter } = makeAdapter({ now: () => nowMs });
    expect(
      await adapter.getIdentityFromCredentials(token({ jti: 'j1', exp: NOW_MS / 1000 + 60 }))
    ).toBe(SUPPORT);
    nowMs = NOW_MS + 30_000;
    expect(
      await adapter.getIdentityFromCredentials(token({ jti: 'j1', exp: NOW_MS / 1000 + 90 }))
    ).toBeNull();
    nowMs = NOW_MS + 61_000;
    expect(
      await adapter.getIdentityFromCredentials(token({ jti: 'j1', exp: NOW_MS / 1000 + 120 }))
    ).toBe(SUPPORT);
  });

  it('refuses new tokens rather than evicting live ones when the replay cache is full', async () => {
    const { adapter, logger } = makeAdapter();
    for (let i = 0; i < MAX_CONSUMED; i += 1) {
      expect(await adapter.getIdentityFromCredentials(token({ jti: `fill-${i}` }))).toBe(SUPPORT);
    }
    expect(await adapter.getIdentityFromCredentials(token({ jti: 'one-more' }))).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (replay cache full)']);
    expect(await adapter.getIdentityFromCredentials(token({ jti: 'fill-0' }))).toBeNull();
  }, 30_000);

  it('refuses when verification itself fails unexpectedly', async () => {
    const { adapter, logger } = makeAdapter({
      now: () => {
        throw new Error('clock unavailable');
      },
    });
    expect(await adapter.getIdentityFromCredentials(token())).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (verification error)']);
  });
});

describe('getUserForIdentity', () => {
  it('looks up only the configured identity', async () => {
    const { adapter, repository } = makeAdapter();
    expect(await adapter.getUserForIdentity(SUPPORT)).toEqual({
      id: `id-of-${SUPPORT}`,
      email: SUPPORT,
    });
    expect(repository.getByEmail).toHaveBeenCalledExactlyOnceWith(SUPPORT);
  });

  it("never resolves any other identity, including the tenant's owner", async () => {
    const { adapter, repository } = makeAdapter();
    expect(await adapter.getUserForIdentity(OWNER)).toBeNull();
    expect(await adapter.getUserForIdentity(undefined)).toBeNull();
    expect(repository.getByEmail).not.toHaveBeenCalled();
    expect(repository.getOwner).not.toHaveBeenCalled();
  });

  it('returns null when the account does not exist', async () => {
    const { adapter } = makeAdapter({
      users: { getByEmail: async () => null, getOwner: async () => null },
    });
    expect(await adapter.getUserForIdentity(SUPPORT)).toBeNull();
  });

  it('returns null when the lookup fails', async () => {
    const { adapter } = makeAdapter({
      users: {
        getByEmail: async () => {
          throw new Error('db down');
        },
        getOwner: async () => null,
      },
    });
    expect(await adapter.getUserForIdentity(SUPPORT)).toBeNull();
  });

  it('returns null when Ghost has not supplied a user repository', async () => {
    const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { now: () => NOW_MS });
    const adapter = new BreakGlassSSO({
      publicKey: tenantKey.publicKeyBase64,
      tenant: TENANT,
      supportIdentity: SUPPORT,
    });
    expect(await adapter.getUserForIdentity(SUPPORT)).toBeNull();
  });
});

describe('the whole exchange, in the order Ghost calls it', () => {
  async function exchange(adapter, req) {
    const credentials = await adapter.getRequestCredentials(req);
    if (!credentials) return null;
    const identity = await adapter.getIdentityFromCredentials(credentials);
    if (!identity) return null;
    return adapter.getUserForIdentity(identity);
  }

  it('produces the support user for a valid token and nothing for an owner-naming one', async () => {
    const { adapter } = makeAdapter();
    expect(await exchange(adapter, { query: { [QUERY_PARAM]: token() } })).toMatchObject({
      email: SUPPORT,
    });
    expect(await exchange(adapter, { query: { [QUERY_PARAM]: token({ sub: OWNER }) } })).toBeNull();
  });
});

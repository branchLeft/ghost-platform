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
  MAX_ISSUE_SKEW_SECONDS,
  MAX_TOKEN_LENGTH,
  MAX_CONSUMED,
} = require('../../src/break-glass.js');
const { default: EntryBreakGlassSSO } = await import('../../src/BreakGlassSSO.js');

const TENANT = 'tenant-zero';
const SUPPORT = 'support@platform.example';
const OWNER = 'owner@example.com';
const NOW_MS = Date.UTC(2026, 8, 24, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const ACCEPTED = 'break-glass: token accepted for the configured identity';

const tenantKey = generateKeyPair();
const otherKey = generateKeyPair();
const goodConfig = {
  publicKey: tenantKey.publicKeyBase64,
  tenant: TENANT,
  supportIdentity: SUPPORT,
};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeAdapter({ config, logger = makeLogger(), now = () => NOW_MS, users } = {}) {
  const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { logger, now });
  const adapter = new BreakGlassSSO(config ?? goodConfig);
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

// The three calls in the order Ghost's session middleware makes them.
async function exchange(adapter, req) {
  const credentials = await adapter.getRequestCredentials(req);
  if (!credentials) return null;
  const lookup = await adapter.getIdentityFromCredentials(credentials);
  if (!lookup) return null;
  return adapter.getUserForIdentity(lookup);
}

const present = (adapter, t) => exchange(adapter, { query: { [QUERY_PARAM]: t } });

function refusalReasons(logger) {
  return logger.warn.mock.calls.map(([message]) => message);
}

describe('parseConfig', () => {
  it('accepts a complete triple with an Ed25519 SPKI key', () => {
    const parsed = parseConfig(goodConfig);
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
    expect(parseConfig(config)).toEqual({ key: null, tenant: null, identity: null, reason });
  });

  it('refuses a well-formed key of another algorithm', () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(parseConfig({ ...goodConfig, publicKey: der }).reason).toBe('publicKey is not ed25519');
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
    ['malformed key', { ...goodConfig, publicKey: 'AAAAAAAA' }],
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
  });

  it('constructs without throwing when the clock is unreadable, and then refuses every token', async () => {
    let clockWorks = false;
    const { adapter, logger } = makeAdapter({
      now: () => {
        if (!clockWorks) throw new Error('clock unavailable');
        return NOW_MS;
      },
    });
    clockWorks = true;
    expect(await present(adapter, token())).toBeNull();
    expect(refusalReasons(logger)).toEqual([
      'break-glass: token refused (issued before this process started)',
    ]);
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
    const adapter = new BreakGlassSSO(goodConfig);
    adapter.setUserRepository({
      getByEmail: async (email) => ({ id: 'x', email }),
      getOwner: async () => null,
    });
    const live = mint(tenantKey.privateKey, claimsFor({ sub: SUPPORT, aud: TENANT }));
    expect(await present(adapter, live)).toMatchObject({ email: SUPPORT });
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
  it('returns a lookup for the configured identity, and records nothing yet', async () => {
    const { adapter, logger } = makeAdapter();
    const lookup = await adapter.getIdentityFromCredentials(token());
    expect(lookup).toMatchObject({ identity: SUPPORT });
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
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
        const rewritten = Buffer.from(
          JSON.stringify(claimsFor({ sub: OWNER, aud: TENANT, nowMs: NOW_MS }))
        ).toString('base64url');
        return `${rewritten}.${sigOf(token())}`;
      },
      'signature',
    ],
    ['signed non-JSON', () => signRaw(tenantKey.privateKey, 'not json'), 'malformed claims'],
    ['signed JSON null', () => signRaw(tenantKey.privateKey, 'null'), 'malformed claims'],
    ['a signed JSON array', () => signRaw(tenantKey.privateKey, '[1,2]'), 'malformed claims'],
    ['a signed JSON number', () => signRaw(tenantKey.privateKey, '7'), 'malformed claims'],
    ['another tenant as audience', () => token({ aud: 'tenant-one' }), 'audience'],
    ['no audience', () => token({ aud: undefined }), 'audience'],
    ['an expired token', () => token({ iat: NOW_S - 120, exp: NOW_S - 60 }), 'expired'],
    ['exp equal to now', () => token({ iat: NOW_S - 60, exp: NOW_S }), 'expired'],
    ['a fractional exp', () => token({ exp: NOW_S + 60.5 }), 'expired'],
    ['a string exp', () => token({ exp: String(NOW_S + 60) }), 'expired'],
    ['no exp', () => token({ exp: undefined }), 'expired'],
    ['no iat', () => token({ iat: undefined }), 'issued-at'],
    ['a string iat', () => token({ iat: String(NOW_S) }), 'issued-at'],
    ['iat not before exp', () => token({ iat: NOW_S + 60, exp: NOW_S + 60 }), 'issued-at'],
    [
      'exp too far from iat',
      () => token({ exp: NOW_S + MAX_TTL_SECONDS + 1 }),
      'lifetime too long',
    ],
    [
      'exp too far from now, with iat in the allowed skew',
      () => token({ iat: NOW_S + 30, exp: NOW_S + MAX_TTL_SECONDS + 1 }),
      'lifetime too long',
    ],
    [
      'iat beyond the clock-skew allowance',
      () =>
        token({
          iat: NOW_S + MAX_ISSUE_SKEW_SECONDS + 1,
          exp: NOW_S + MAX_ISSUE_SKEW_SECONDS + 60,
        }),
      'issued in the future',
    ],
    [
      'iat before this process started',
      () => token({ iat: NOW_S - 1, exp: NOW_S + 300 }),
      'issued before this process started',
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

  it('accepts a lifetime exactly at the cap, and an iat within the skew allowance', async () => {
    const { adapter } = makeAdapter();
    expect(await present(adapter, token({ exp: NOW_S + MAX_TTL_SECONDS }))).toMatchObject({
      email: SUPPORT,
    });
    expect(
      await present(adapter, token({ iat: NOW_S + MAX_ISSUE_SKEW_SECONDS, exp: NOW_S + 600 }))
    ).toMatchObject({ email: SUPPORT });
  });

  it('refuses when verification itself fails unexpectedly', async () => {
    let calls = 0;
    const { adapter, logger } = makeAdapter({
      now: () => {
        calls += 1;
        if (calls > 1) throw new Error('clock unavailable');
        return NOW_MS;
      },
    });
    expect(await adapter.getIdentityFromCredentials(token())).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (verification error)']);
  });
});

describe('single use', () => {
  it('consumes a token once the account is found, and refuses its replay', async () => {
    const { adapter, logger } = makeAdapter();
    const once = token();
    expect(await present(adapter, once)).toMatchObject({ email: SUPPORT });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(ACCEPTED);
    expect(await present(adapter, once)).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (replay)']);
  });

  it('lets exactly one of two concurrent requests with the same token through', async () => {
    const { adapter } = makeAdapter();
    const t = token();
    const lookups = await Promise.all([
      adapter.getIdentityFromCredentials(t),
      adapter.getIdentityFromCredentials(t),
    ]);
    const users = await Promise.all(lookups.map((l) => adapter.getUserForIdentity(l)));
    expect(users.filter(Boolean)).toHaveLength(1);
  });

  // A refused token carrying a legitimate token's jti must not use it up:
  // otherwise anyone who can guess a pending jti can deny support access.
  it.each([
    ['signature', (jti) => token({ jti }, otherKey.privateKey)],
    ['audience', (jti) => token({ jti, aud: 'tenant-one' })],
    ['expired', (jti) => token({ jti, iat: NOW_S - 120, exp: NOW_S - 60 })],
    ['lifetime too long', (jti) => token({ jti, exp: NOW_S + MAX_TTL_SECONDS + 1 })],
    ['issued before this process started', (jti) => token({ jti, iat: NOW_S - 1 })],
    ['subject', (jti) => token({ jti, sub: OWNER })],
  ])('a token refused for %s does not consume the jti it carries', async (reason, build) => {
    const { adapter, logger } = makeAdapter();
    const jti = 'pending-legitimate-jti';
    expect(await present(adapter, build(jti))).toBeNull();
    expect(refusalReasons(logger)).toEqual([`break-glass: token refused (${reason})`]);
    expect(await present(adapter, token({ jti }))).toMatchObject({ email: SUPPORT });
  });

  it('does not consume a token when the account does not exist yet', async () => {
    let exists = false;
    const { adapter, logger } = makeAdapter({
      users: {
        getByEmail: async (email) => (exists ? { id: 'support-id', email } : null),
        getOwner: async () => null,
      },
    });
    const t = token();
    expect(await present(adapter, t)).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (no such account)']);
    exists = true;
    expect(await present(adapter, t)).toMatchObject({ email: SUPPORT });
  });

  it('forgets a used jti only once its token has expired', async () => {
    let nowMs = NOW_MS;
    const { adapter } = makeAdapter({ now: () => nowMs });
    expect(await present(adapter, token({ jti: 'j1', exp: NOW_S + 60 }))).toMatchObject({
      email: SUPPORT,
    });
    nowMs = NOW_MS + 30_000;
    expect(await present(adapter, token({ jti: 'j1', exp: NOW_S + 90 }))).toBeNull();
    nowMs = NOW_MS + 61_000;
    expect(await present(adapter, token({ jti: 'j1', exp: NOW_S + 120 }))).toMatchObject({
      email: SUPPORT,
    });
  });

  it('refuses new tokens rather than evicting live ones when the replay cache is full', async () => {
    const { adapter, logger } = makeAdapter();
    for (let i = 0; i < MAX_CONSUMED; i += 1) {
      expect(await present(adapter, token({ jti: `fill-${i}` }))).not.toBeNull();
    }
    expect(await present(adapter, token({ jti: 'one-more' }))).toBeNull();
    expect(refusalReasons(logger)).toEqual(['break-glass: token refused (replay cache full)']);
    expect(await present(adapter, token({ jti: 'fill-0' }))).toBeNull();
  }, 30_000);
});

describe('getUserForIdentity', () => {
  it('looks up only the configured identity', async () => {
    const { adapter, repository } = makeAdapter();
    expect(await present(adapter, token())).toEqual({ id: `id-of-${SUPPORT}`, email: SUPPORT });
    expect(repository.getByEmail).toHaveBeenCalledExactlyOnceWith(SUPPORT);
  });

  it('honours only lookups the adapter itself produced', async () => {
    const { adapter, repository } = makeAdapter();
    for (const forged of [
      SUPPORT,
      OWNER,
      undefined,
      { identity: SUPPORT, jti: 'x', exp: NOW_S + 60 },
    ]) {
      expect(await adapter.getUserForIdentity(forged)).toBeNull();
    }
    expect(repository.getByEmail).not.toHaveBeenCalled();
    expect(repository.getOwner).not.toHaveBeenCalled();
  });

  it("does not honour one adapter's lookup in another configured for a different identity", async () => {
    const { adapter } = makeAdapter();
    const lookup = await adapter.getIdentityFromCredentials(token());
    const { adapter: other, repository } = makeAdapter({
      config: { ...goodConfig, supportIdentity: OWNER },
    });
    expect(await other.getUserForIdentity(lookup)).toBeNull();
    expect(repository.getByEmail).not.toHaveBeenCalled();
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
    expect(await present(adapter, token())).toBeNull();
  });

  it('returns null when Ghost has not supplied a user repository', async () => {
    const BreakGlassSSO = defineBreakGlassSSO(SSOBase, { now: () => NOW_MS });
    const adapter = new BreakGlassSSO(goodConfig);
    const lookup = await adapter.getIdentityFromCredentials(token());
    expect(await adapter.getUserForIdentity(lookup)).toBeNull();
  });
});

describe('the whole exchange, in the order Ghost calls it', () => {
  it('produces the support user for a valid token and nothing for an owner-naming one', async () => {
    const { adapter } = makeAdapter();
    expect(await present(adapter, token())).toMatchObject({ email: SUPPORT });
    expect(await present(adapter, token({ sub: OWNER }))).toBeNull();
  });
});

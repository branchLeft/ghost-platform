import { describe, expect, it } from 'vitest';
import { loadConfig, type AskEnv } from '../../src/config.js';

const base: AskEnv = {
  BIND_HOST: '127.0.0.1',
  DESCRIPTOR_DIR: '/descriptors',
  BASE_DOMAIN: 'sites.publicpress.co.uk',
  OWNED_DOMAINS: 'publicpress.co.uk,trypublicpress.co.uk',
};

describe('loadConfig', () => {
  it('applies defaults for everything that does not decide admission or bind address', () => {
    const config = loadConfig(base);
    expect(config).toStrictEqual({
      port: 9000,
      bindHost: '127.0.0.1',
      descriptorDir: '/descriptors',
      platformZone: 'sites.publicpress.co.uk',
      ownedDomains: ['publicpress.co.uk', 'trypublicpress.co.uk'],
      refreshIntervalMs: 5000,
      descriptorMaxStalenessMs: 60_000,
      rateLimitCapacity: 50,
      rateLimitRefillPerSecond: 10,
    });
  });

  it('reads every override', () => {
    const config = loadConfig({
      ...base,
      PORT: '9100',
      REFRESH_INTERVAL_MS: '1000',
      DESCRIPTOR_MAX_STALENESS_MS: '30000',
      RATE_LIMIT_CAPACITY: '5',
      RATE_LIMIT_REFILL_PER_SECOND: '2',
    });
    expect(config).toMatchObject({
      port: 9100,
      refreshIntervalMs: 1000,
      descriptorMaxStalenessMs: 30_000,
      rateLimitCapacity: 5,
      rateLimitRefillPerSecond: 2,
    });
  });

  // The load-bearing row: BIND_HOST has no fallback, so a deployment that
  // forgets to set it fails to start rather than silently listening on
  // every interface (LLD-5 E2).
  it.each(['BIND_HOST', 'DESCRIPTOR_DIR', 'BASE_DOMAIN', 'OWNED_DOMAINS'])(
    'refuses to start without %s',
    (name) => {
      const env = { ...base, [name]: undefined };
      expect(() => loadConfig(env)).toThrow(name);
    }
  );

  it('refuses an empty BIND_HOST the same as a missing one', () => {
    expect(() => loadConfig({ ...base, BIND_HOST: '' })).toThrow('BIND_HOST');
  });

  // The other half of the same claim reachability.test.ts proves against
  // the real running process: a *configured* wildcard is refused before
  // the process ever starts, so the only way to actually reach every
  // interface is a wiring bug downstream of this check, not a value an
  // operator could set here.
  it.each(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', ' 0.0.0.0 '])(
    'refuses a wildcard BIND_HOST of %j',
    (value) => {
      expect(() => loadConfig({ ...base, BIND_HOST: value })).toThrow('BIND_HOST');
    }
  );

  it('does not refuse a specific address that merely contains wildcard-looking characters', () => {
    // Guards against an over-eager matcher: a real, specific address must
    // never be caught by the wildcard check.
    expect(() => loadConfig({ ...base, BIND_HOST: '10.20.1.50' })).not.toThrow();
    expect(() => loadConfig({ ...base, BIND_HOST: 'fd00::1' })).not.toThrow();
  });

  it('refuses a missing/empty OWNED_DOMAINS', () => {
    expect(() => loadConfig({ ...base, OWNED_DOMAINS: '' })).toThrow('OWNED_DOMAINS');
    expect(() => loadConfig({ ...base, OWNED_DOMAINS: ' , ,' })).toThrow('OWNED_DOMAINS');
  });

  it('trims whitespace around comma-separated OWNED_DOMAINS entries', () => {
    const config = loadConfig({
      ...base,
      OWNED_DOMAINS: ' publicpress.co.uk , trypublicpress.co.uk ',
    });
    expect(config.ownedDomains).toEqual(['publicpress.co.uk', 'trypublicpress.co.uk']);
  });

  it('refuses a malformed OWNED_DOMAINS entry', () => {
    expect(() =>
      loadConfig({ ...base, OWNED_DOMAINS: 'publicpress.co.uk,not a hostname' })
    ).toThrow('OWNED_DOMAINS');
  });

  it('refuses a malformed BASE_DOMAIN', () => {
    expect(() => loadConfig({ ...base, BASE_DOMAIN: 'not a hostname' })).toThrow('BASE_DOMAIN');
  });

  it.each(['0', '-1', 'ten', ''])(
    'falls back to the default port for a non-positive PORT of %j',
    (value) => {
      const config = loadConfig({ ...base, PORT: value });
      expect(config.port).toBe(9000);
    }
  );

  it('floors a fractional positive override rather than refusing it', () => {
    const config = loadConfig({ ...base, PORT: '1.5', RATE_LIMIT_CAPACITY: '5.9' });
    expect(config.port).toBe(1);
    expect(config.rateLimitCapacity).toBe(5);
  });
});

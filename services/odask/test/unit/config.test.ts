import { describe, expect, it } from 'vitest';
import { loadConfig, type AskEnv } from '../../src/config.js';

const base: AskEnv = {
  BIND_HOST: '127.0.0.1',
  DESCRIPTOR_DIR: '/descriptors',
  BASE_DOMAIN: 'sites.publicpress.co.uk',
};

describe('loadConfig', () => {
  it('applies defaults for everything that does not decide admission or bind address', () => {
    const config = loadConfig(base);
    expect(config).toStrictEqual({
      port: 9000,
      bindHost: '127.0.0.1',
      descriptorDir: '/descriptors',
      baseDomain: 'sites.publicpress.co.uk',
      refreshIntervalMs: 5000,
      rateLimitCapacity: 50,
      rateLimitRefillPerSecond: 10,
    });
  });

  it('reads every override', () => {
    const config = loadConfig({
      ...base,
      PORT: '9100',
      REFRESH_INTERVAL_MS: '1000',
      RATE_LIMIT_CAPACITY: '5',
      RATE_LIMIT_REFILL_PER_SECOND: '2',
    });
    expect(config).toMatchObject({
      port: 9100,
      refreshIntervalMs: 1000,
      rateLimitCapacity: 5,
      rateLimitRefillPerSecond: 2,
    });
  });

  // The load-bearing row: BIND_HOST has no fallback, so a deployment that
  // forgets to set it fails to start rather than silently listening on
  // every interface (LLD-5 E2).
  it.each(['BIND_HOST', 'DESCRIPTOR_DIR', 'BASE_DOMAIN'])('refuses to start without %s', (name) => {
    const env = { ...base, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(name);
  });

  it('refuses an empty BIND_HOST the same as a missing one', () => {
    expect(() => loadConfig({ ...base, BIND_HOST: '' })).toThrow('BIND_HOST');
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

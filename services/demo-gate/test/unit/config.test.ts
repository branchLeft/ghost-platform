import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const KEY = Buffer.alloc(32, 1);
const base = {
  GATE_SIGNING_KEY_FILE: '/k',
  GATE_SLOTS_FILE: '/s.json',
  GATE_LEASE_DIR: '/leases',
};
const load = (env: Record<string, string | undefined>, key = KEY) => loadConfig(env, () => key);

describe('loadConfig', () => {
  it('applies defaults for everything that does not decide admission', () => {
    const config = load(base);
    expect(config).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
      slotsPath: '/s.json',
      leaseDir: '/leases',
      cookieTtlSeconds: 43200,
      ceilingLimit: 10,
      ceilingWindowMs: 900_000,
      ceilingMaxSources: 100_000,
    });
    expect(config.trustedProxies.check('127.0.0.1', 'ipv4')).toBe(false);
  });

  it('reads every override', () => {
    const config = load({
      ...base,
      PORT: '9000',
      LISTEN_HOST: '0.0.0.0',
      GATE_TRUSTED_PROXIES: '172.30.0.2',
      GATE_COOKIE_TTL_SECONDS: '60',
      GATE_CEILING_ATTEMPTS: '3',
      GATE_CEILING_WINDOW_SECONDS: '30',
      GATE_CEILING_MAX_SOURCES: '5',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      cookieTtlSeconds: 60,
      ceilingLimit: 3,
      ceilingWindowMs: 30_000,
      ceilingMaxSources: 5,
    });
    expect(config.trustedProxies.check('172.30.0.2', 'ipv4')).toBe(true);
  });

  it.each(['GATE_SIGNING_KEY_FILE', 'GATE_SLOTS_FILE', 'GATE_LEASE_DIR'])(
    'refuses to start without %s',
    (name) => {
      expect(() => load({ ...base, [name]: undefined })).toThrow(name);
    }
  );

  it('refuses a signing key shorter than 32 bytes', () => {
    expect(() => load(base, Buffer.alloc(31))).toThrow(/at least 32 bytes/);
  });

  it.each(['0', '-1', '1.5', 'ten', '604801'])('refuses a cookie TTL of %j', (value) => {
    expect(() => load({ ...base, GATE_COOKIE_TTL_SECONDS: value })).toThrow(
      /GATE_COOKIE_TTL_SECONDS/
    );
  });

  it('refuses a malformed trusted-proxy list', () => {
    expect(() => load({ ...base, GATE_TRUSTED_PROXIES: 'edge' })).toThrow();
  });

  it('reads the key through the default file reader', () => {
    expect(() => loadConfig({ ...base, GATE_SIGNING_KEY_FILE: '/nonexistent/key' })).toThrow();
  });
});

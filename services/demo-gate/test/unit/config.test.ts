import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createSourceResolver } from '../../src/source.js';

const KEY = Buffer.alloc(32, 1);
const base = {
  GATE_SIGNING_KEY_FILE: '/k',
  GATE_SLOTS_FILE: '/s.json',
  GATE_LEASE_DIR: '/leases',
};
const load = (env: Record<string, string | undefined>, key = KEY) => loadConfig(env, () => key);
// The one address the demo edge presents to the gate: the host loopback it
// shares a network namespace with (demo-host/provision/render_demo_site.py).
const EDGE = '127.0.0.1';

describe('loadConfig', () => {
  it('applies defaults for everything that does not decide admission', () => {
    const config = load({ ...base, GATE_TRUSTED_PROXIES: EDGE });
    expect(config).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
      slotsPath: '/s.json',
      leaseDir: '/leases',
      cookieTtlSeconds: 43200,
      ceilingLimit: 10,
      ceilingWindowMs: 900_000,
      ceilingMaxSources: 100_000,
      ceilingBroadLimit: 1000,
      ceilingBroadMaxSources: 20_000,
      // Below the libuv threadpool's own default size (4) -- see
      // config.ts's comment for the measurement this default is chosen
      // from.
      argon2MaxConcurrent: 3,
      argon2MaxQueued: 64,
    });
  });

  it('trusts nobody when no list is given and the gate is not on a loopback address', () => {
    const config = load({ ...base, LISTEN_HOST: '0.0.0.0' });
    expect(config.trustedProxies.check('127.0.0.1', 'ipv4')).toBe(false);
    expect(config.trustedProxies.check('172.30.0.2', 'ipv4')).toBe(false);
    expect(config.trustedProxies.check('::1', 'ipv6')).toBe(false);
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
      GATE_CEILING_BROAD_ATTEMPTS: '40',
      GATE_CEILING_BROAD_MAX_SOURCES: '50',
      GATE_ARGON2_MAX_CONCURRENT: '2',
      GATE_ARGON2_MAX_QUEUED: '8',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      cookieTtlSeconds: 60,
      ceilingLimit: 3,
      ceilingWindowMs: 30_000,
      ceilingMaxSources: 5,
      ceilingBroadLimit: 40,
      ceilingBroadMaxSources: 50,
      argon2MaxConcurrent: 2,
      argon2MaxQueued: 8,
    });
    expect(config.trustedProxies.check('172.30.0.2', 'ipv4')).toBe(true);
  });

  it.each(['GATE_SIGNING_KEY_FILE', 'GATE_SLOTS_FILE', 'GATE_LEASE_DIR'])(
    'refuses to start without %s',
    (name) => {
      expect(() => load({ ...base, GATE_TRUSTED_PROXIES: EDGE, [name]: undefined })).toThrow(name);
    }
  );

  it('refuses a signing key shorter than 32 bytes', () => {
    expect(() => load(base, Buffer.alloc(31))).toThrow(/at least 32 bytes/);
  });

  it.each(['0', '-1', '1.5', 'ten', '604801'])('refuses a cookie TTL of %j', (value) => {
    expect(() =>
      load({ ...base, GATE_TRUSTED_PROXIES: EDGE, GATE_COOKIE_TTL_SECONDS: value })
    ).toThrow(/GATE_COOKIE_TTL_SECONDS/);
  });

  describe('a loopback listener with no trusted proxy', () => {
    // The peers on a loopback listener are host-local processes, the edge
    // being the one this repo places: with nobody trusted, every visitor
    // shares one ceiling bucket.
    it.each([
      ['the default listen address', undefined],
      ['127.0.0.1', '127.0.0.1'],
      ['another 127/8 address', '127.1.2.3'],
      ['::1', '::1'],
      ['a bracketed ::1', '[::1]'],
      ['the long form of ::1', '0:0:0:0:0:0:0:1'],
      ['an IPv4-mapped loopback', '::ffff:127.0.0.1'],
      ['localhost', 'LocalHost'],
    ])('refuses to start on %s', (_label, host) => {
      expect(() => load({ ...base, LISTEN_HOST: host })).toThrow(/GATE_TRUSTED_PROXIES/);
    });

    it('treats a list of only blanks as empty', () => {
      expect(() => load({ ...base, GATE_TRUSTED_PROXIES: ' , ,' })).toThrow(/GATE_TRUSTED_PROXIES/);
    });

    it.each(['0.0.0.0', '::', '10.0.0.5', '172.30.0.2', '2001:db8::1'])(
      'does not refuse a non-loopback listen address %s with no list',
      (host) => {
        expect(() => load({ ...base, LISTEN_HOST: host })).not.toThrow();
      }
    );

    it('starts once the edge is named', () => {
      expect(() => load({ ...base, GATE_TRUSTED_PROXIES: EDGE })).not.toThrow();
    });
  });

  describe('the source a configured gate keys on', () => {
    const resolver = () =>
      createSourceResolver(load({ ...base, GATE_TRUSTED_PROXIES: EDGE }).trustedProxies);

    it('honours the forwarded address from the edge, rightmost entry only', () => {
      expect(resolver().resolve(EDGE, '198.51.100.7, 203.0.113.9')).toBe('203.0.113.9');
    });

    it('ignores a forwarded address sent by any other peer', () => {
      expect(resolver().resolve('203.0.113.50', '10.9.9.9')).toBe('203.0.113.50');
      expect(resolver().resolve('172.30.0.9', EDGE)).toBe('172.30.0.9');
    });

    it('trusts the edge address only, not the whole loopback range', () => {
      expect(resolver().resolve('127.0.0.2', '10.9.9.9')).toBe('127.0.0.2');
      expect(resolver().resolve('::1', '10.9.9.9')).toBe('0:0:0:0::/64');
    });
  });

  it('refuses a malformed trusted-proxy list', () => {
    expect(() => load({ ...base, GATE_TRUSTED_PROXIES: 'edge' })).toThrow();
  });

  it('reads the key through the default file reader', () => {
    expect(() => loadConfig({ ...base, GATE_SIGNING_KEY_FILE: '/nonexistent/key' })).toThrow();
  });
});

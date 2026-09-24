import { describe, expect, it } from 'vitest';
import {
  ceilingKey,
  ceilingKeyBroad,
  createSourceResolver,
  parseTrustedProxies,
  TrustedProxyFormatError,
} from '../../src/source.js';

describe('ceilingKey', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:ffff::1', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
    [' 203.0.113.9 ', '203.0.113.9'],
  ])('keys %s as %s', (address, key) => {
    expect(ceilingKey(address)).toBe(key);
  });

  it('keys two addresses in one /64 identically', () => {
    expect(ceilingKey('2001:db8:1:2::1')).toBe(ceilingKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    expect(ceilingKey('2001:db8:1:3::1')).not.toBe(ceilingKey('2001:db8:1:2::1'));
  });

  it.each(['', 'unknown', '203.0.113', 'fe80::1%eth0', '::ffff:1.2.3.4.5', '64:ff9b::1.2.3.4'])(
    'refuses %j',
    (address) => {
      expect(ceilingKey(address)).toBeNull();
    }
  );
});

describe('ceilingKeyBroad', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1::/48'],
    ['2001:db8:1:9999::9', '2001:db8:1::/48'],
    ['2001:DB8:1:2:ffff::1', '2001:db8:1::/48'],
    [' 203.0.113.9 ', '203.0.113.9'],
  ])('keys %s as %s', (address, key) => {
    expect(ceilingKeyBroad(address)).toBe(key);
  });

  it('keys every /64 inside one /48 identically, but not a different /48', () => {
    expect(ceilingKeyBroad('2001:db8:1:2::1')).toBe(ceilingKeyBroad('2001:db8:1:3::1'));
    expect(ceilingKeyBroad('2001:db8:1:2::1')).toBe(ceilingKeyBroad('2001:db8:1:ffff::1'));
    expect(ceilingKeyBroad('2001:db8:2:2::1')).not.toBe(ceilingKeyBroad('2001:db8:1:2::1'));
  });

  it('agrees with ceilingKey on IPv4, where there is no broader tier', () => {
    expect(ceilingKeyBroad('203.0.113.9')).toBe(ceilingKey('203.0.113.9'));
  });

  it.each(['', 'unknown', '203.0.113', 'fe80::1%eth0', '::ffff:1.2.3.4.5', '64:ff9b::1.2.3.4'])(
    'refuses %j',
    (address) => {
      expect(ceilingKeyBroad(address)).toBeNull();
    }
  );
});

describe('parseTrustedProxies', () => {
  it('accepts addresses and CIDRs of both families', () => {
    const list = parseTrustedProxies('127.0.0.1, 172.30.0.0/16,::1,fd00::/8');
    expect(list.check('127.0.0.1', 'ipv4')).toBe(true);
    expect(list.check('172.30.9.9', 'ipv4')).toBe(true);
    expect(list.check('172.31.0.1', 'ipv4')).toBe(false);
    expect(list.check('fd12::1', 'ipv6')).toBe(true);
  });

  it('trusts nothing when empty', () => {
    expect(parseTrustedProxies('').check('127.0.0.1', 'ipv4')).toBe(false);
  });

  it.each(['localhost', '10.0.0.0/33', '10.0.0.0/x', '10.0.0.0/8/1', '::/129', '10.0.0.0/'])(
    'refuses %j',
    (spec) => {
      expect(() => parseTrustedProxies(spec)).toThrow(TrustedProxyFormatError);
    }
  );
});

describe('createSourceResolver', () => {
  const resolver = createSourceResolver(parseTrustedProxies('172.30.0.2'));

  it('uses the socket peer and ignores X-Forwarded-For from an untrusted peer', () => {
    expect(resolver.resolve('203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
    expect(resolver.resolve('::ffff:203.0.113.9', undefined)).toBe('203.0.113.9');
  });

  it('uses the rightmost X-Forwarded-For entry from a trusted peer', () => {
    expect(resolver.resolve('172.30.0.2', '198.51.100.1, 203.0.113.9')).toBe('203.0.113.9');
    expect(resolver.resolve('::ffff:172.30.0.2', ['1.1.1.1', '203.0.113.9'])).toBe('203.0.113.9');
  });

  it('refuses a trusted peer that sends no usable header, rather than keying on the proxy', () => {
    expect(resolver.resolve('172.30.0.2', undefined)).toBeNull();
    expect(resolver.resolve('172.30.0.2', '')).toBeNull();
    expect(resolver.resolve('172.30.0.2', '203.0.113.9, garbage')).toBeNull();
  });

  it('refuses a request with no peer address', () => {
    expect(resolver.resolve(undefined, '203.0.113.9')).toBeNull();
  });

  it('refuses a peer that is not an address', () => {
    expect(resolver.resolve('not-an-ip', undefined)).toBeNull();
  });

  it('resolveBroad keys the same effective address, broadened', () => {
    expect(resolver.resolveBroad('2001:db8:1:2::9', undefined)).toBe('2001:db8:1::/48');
    expect(resolver.resolveBroad('172.30.0.2', '198.51.100.1, 2001:db8:1:2::9')).toBe(
      '2001:db8:1::/48'
    );
  });

  it('resolveBroad refuses exactly when resolve does', () => {
    expect(resolver.resolveBroad('172.30.0.2', undefined)).toBeNull();
    expect(resolver.resolveBroad(undefined, '203.0.113.9')).toBeNull();
  });
});

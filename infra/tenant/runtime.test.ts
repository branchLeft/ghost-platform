import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPLOAD_CEILING_MIB,
  TENANT_UID_MAX,
  TENANT_UID_MIN,
  uploadLimits,
  validateAppHostPrivateIp,
  validateHostPort,
  validateTenantUid,
} from './runtime';

const MIB = 1024 * 1024;

describe('validateTenantUid', () => {
  it.each([TENANT_UID_MIN, 30500, TENANT_UID_MAX])('accepts %i', (uid) => {
    expect(() => validateTenantUid(uid)).not.toThrow();
  });

  // Outside the reserved range a UID may belong to a real host account, whose
  // group memberships the tenant container would then inherit.
  it.each([0, 1, 1000, TENANT_UID_MIN - 1, TENANT_UID_MAX + 1, 65534])('rejects %i', (uid) => {
    expect(() => validateTenantUid(uid)).toThrow(/reserved tenant range/);
  });

  it.each([30000.5, NaN, Infinity])('rejects the non-integer %s', (uid) => {
    expect(() => validateTenantUid(uid)).toThrow();
  });
});

describe('uploadLimits', () => {
  it('derives every limit from one ceiling', () => {
    const limits = uploadLimits(128, 512);
    expect(limits.tmpfsSize).toBe('128m');
    expect(limits.themeCompressedBytes).toBe(32 * MIB);
    expect(limits.themeEntryUncompressedBytes).toBe(32 * MIB);
    expect(limits.themeTotalUncompressedBytes).toBe(64 * MIB);
    // MiB, not MB: Caddy reads `MB` as a power of ten, and every sibling
    // value here is a power of two. The point of one input is that they
    // cannot disagree.
    expect(limits.edgeRequestBodyMaxSize).toBe('64MiB');
    // mem_limit is the RSS budget PLUS the tmpfs ceiling: tmpfs pages are
    // charged to the container's own memory cgroup, so the tmpfs is not free
    // headroom.
    expect(limits.memoryLimit).toBe('640m');
  });

  // The three values that must agree are the point of the single input: theme
  // extraction stages both the archive and its expansion in /tmp, so the
  // uncompressed total can never exceed the tmpfs.
  it('keeps the theme ceilings inside the tmpfs at every legal ceiling', () => {
    for (const ceiling of [16, 32, 64, 128, 256, 1024]) {
      const limits = uploadLimits(ceiling);
      const tmpfsBytes = ceiling * MIB;
      expect(limits.themeTotalUncompressedBytes).toBeLessThan(tmpfsBytes);
      expect(limits.themeCompressedBytes + limits.themeTotalUncompressedBytes).toBeLessThanOrEqual(
        tmpfsBytes
      );
      expect(Number(limits.edgeRequestBodyMaxSize.replace('MiB', '')) * MIB).toBeLessThan(
        tmpfsBytes
      );
    }
  });

  it('stays well below Ghost 6.55.0 own defaults at the platform default', () => {
    const limits = uploadLimits(DEFAULT_UPLOAD_CEILING_MIB);
    expect(limits.themeCompressedBytes).toBeLessThan(1073741824);
    expect(limits.themeEntryUncompressedBytes).toBeLessThan(536870912);
    expect(limits.themeTotalUncompressedBytes).toBeLessThan(4294967296);
  });

  it.each([15, 0, -4, 12.5])('rejects the unusable ceiling %s', (ceiling) => {
    expect(() => uploadLimits(ceiling)).toThrow(/uploadCeilingMib/);
  });

  it('rejects a ceiling that would not divide into whole MiB', () => {
    expect(() => uploadLimits(18)).toThrow(/multiple of 4/);
  });

  it('rejects a non-positive RSS budget', () => {
    expect(() => uploadLimits(128, 0)).toThrow(/rssBudgetMib/);
  });
});

describe('validateAppHostPrivateIp', () => {
  it.each(['10.20.1.100', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1'])(
    'accepts the private address %s',
    (address) => {
      expect(() => validateAppHostPrivateIp(address)).not.toThrow();
    }
  );

  // `0.0.0.0` is the one that matters, and it is the one a check written
  // against the string it produced cannot catch: the rendered port really does
  // begin `0.0.0.0:`. Publishing there puts a tenant on the app host's public
  // interface behind nothing but a firewall rule.
  it.each(['0.0.0.0', '46.225.95.167', '8.8.8.8', '172.32.0.1', '11.0.0.1', '169.254.169.254'])(
    'refuses the non-private address %s',
    (address) => {
      expect(() => validateAppHostPrivateIp(address)).toThrow(/not in a private IPv4 range/);
    }
  );

  // A stack bound to loopback is a site the edge can never reach — it starts,
  // it looks healthy, and it silently never serves.
  it('refuses loopback', () => {
    expect(() => validateAppHostPrivateIp('127.0.0.1')).toThrow(/not in a private IPv4 range/);
  });

  it.each(['', 'localhost', '10.20.1', '10.20.1.100.5', '10.20.1.256', '::1', '10.20.1.1a'])(
    'refuses the malformed address %s',
    (address) => {
      expect(() => validateAppHostPrivateIp(address)).toThrow();
    }
  );

  // Read as octal by some resolvers and decimal by others, so the same string
  // names two different hosts.
  it('refuses a leading-zero octet rather than normalising it', () => {
    expect(() => validateAppHostPrivateIp('010.20.1.100')).toThrow();
  });
});

describe('validateHostPort', () => {
  it.each([1024, 2368, 8080, 65535])('accepts %i', (port) => {
    expect(() => validateHostPort(port)).not.toThrow();
  });

  // 22 is the one that matters on a host that already runs SSH.
  it.each([22, 0, 80, 443, 1023, 65536, -1, 2368.5])('refuses %s', (port) => {
    expect(() => validateHostPort(port)).toThrow(/hostPort/);
  });
});

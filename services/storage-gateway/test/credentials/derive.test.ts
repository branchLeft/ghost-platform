import { describe, expect, it } from 'vitest';
import {
  TENANT_SECRET_LABEL,
  deriveTenantSecret,
  hkdfSha256,
  isValidKeyId,
  tenantSecretInfo,
} from '../../src/credentials/derive.js';
import { MasterSecret } from '../../src/credentials/masterSecret.js';

const hex = (s: string) => Buffer.from(s, 'hex');
const range = (from: number, to: number) =>
  Buffer.from(Array.from({ length: to - from + 1 }, (_, i) => from + i));

// RFC 5869, Appendix A, test cases 1 to 3 (the SHA-256 cases).
const RFC5869_SHA256 = [
  {
    name: 'A.1 basic',
    ikm: Buffer.alloc(22, 0x0b),
    salt: range(0x00, 0x0c),
    info: range(0xf0, 0xf9),
    length: 42,
    okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  },
  {
    name: 'A.2 longer inputs and outputs',
    ikm: range(0x00, 0x4f),
    salt: range(0x60, 0xaf),
    info: range(0xb0, 0xff),
    length: 82,
    okm:
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c' +
      '59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71' +
      'cc30c58179ec3e87c14c01d5c1f3434f1d87',
  },
  {
    name: 'A.3 zero-length salt and info',
    ikm: Buffer.alloc(22, 0x0b),
    salt: Buffer.alloc(0),
    info: Buffer.alloc(0),
    length: 42,
    okm: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  },
];

const MASTER = MasterSecret.fromBytes(range(0x00, 0x1f));
const KEY_A = 'GWAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'GWAAAAAAAAAAAAAAAAAAAAAAAB';

describe('hkdfSha256', () => {
  it.each(RFC5869_SHA256)('matches RFC 5869 test case $name', (tc) => {
    expect(hkdfSha256(tc.ikm, tc.salt, tc.info, tc.length)).toEqual(hex(tc.okm));
  });
});

describe('deriveTenantSecret', () => {
  // Computed by an independent HKDF (Python's hmac and hashlib) over the
  // same master secret, label and key ids. A change to the label, the
  // separator, the salt or the length breaks these.
  it('matches known answers computed outside this code', () => {
    expect(deriveTenantSecret(MASTER, KEY_A)).toBe('V0oIJ4IMD18Lw-kW1-pRJa0hcDdO2ipcE0zqMk0j0HE');
    expect(deriveTenantSecret(MASTER, KEY_B)).toBe('GrV41lNrxyKxqWtlKryXWY7iLj5KSamYnBQwcA9oJFo');
  });

  it('separates by domain: the same key id without the label gives a different secret', () => {
    expect(TENANT_SECRET_LABEL).toBe('branchleft/storage-gateway/tenant-sigv4-secret/v1');
    const unlabelled = hkdfSha256(range(0x00, 0x1f), Buffer.alloc(0), Buffer.from(KEY_A), 32);
    expect(unlabelled.toString('base64url')).toBe('qdfdPvzKCIZ-jZXY6a4qcPaBwardbtrzvxetop0ju3g');
    expect(deriveTenantSecret(MASTER, KEY_A)).not.toBe(unlabelled.toString('base64url'));
    expect(tenantSecretInfo(KEY_A)).toEqual(
      Buffer.concat([Buffer.from(TENANT_SECRET_LABEL), Buffer.from([0]), Buffer.from(KEY_A)])
    );
  });

  it('is deterministic for one key id and differs across key ids', () => {
    expect(deriveTenantSecret(MASTER, KEY_A)).toBe(deriveTenantSecret(MASTER, KEY_A));
    const secrets = new Set(
      Array.from({ length: 50 }, (_, i) =>
        deriveTenantSecret(MASTER, `GW${String(i).padStart(18, '0')}`)
      )
    );
    expect(secrets.size).toBe(50);
  });

  it('differs across master secrets for the same key id', () => {
    const other = MasterSecret.fromBytes(range(0x01, 0x20));
    expect(deriveTenantSecret(other, KEY_A)).not.toBe(deriveTenantSecret(MASTER, KEY_A));
  });

  it('gives 32 bytes of secret as unpadded base64url', () => {
    const secret = deriveTenantSecret(MASTER, KEY_A);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
  });

  it.each([
    '',
    'short',
    'gwlowercase000000000',
    `GW${'A'.repeat(63)}`,
    'GWAAAAAAAAAAAAAA\0AAAA',
    'GW/AAAAAAAAAAAAAAAAAA',
  ])('refuses the malformed key id %j', (keyId) => {
    expect(isValidKeyId(keyId)).toBe(false);
    expect(() => deriveTenantSecret(MASTER, keyId)).toThrow('key id is not well formed');
  });
});

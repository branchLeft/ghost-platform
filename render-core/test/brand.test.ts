import { describe, expect, it } from 'vitest';
import {
  FieldValidationError,
  TENANT_UID_MAX,
  TENANT_UID_MIN,
  validateAbsoluteUrl,
  validateDigestPinnedRef,
  validateInstant,
  validatePort,
  validatePrivateIpV4,
  validateSlug,
  validateTenantUid,
} from '../src/brand.js';

const DIGEST = 'b'.repeat(64);

describe('validateSlug', () => {
  it('accepts a well-formed slug', () => {
    expect(validateSlug('acme-1')).toBe('acme-1');
  });

  it('accepts a single-character slug', () => {
    expect(validateSlug('a')).toBe('a');
  });

  it.each([
    ['starts with a digit', '1acme'],
    ['starts with a hyphen', '-acme'],
    ['ends with a hyphen', 'acme-'],
    ['contains uppercase', 'Acme'],
    ['contains an underscore', 'ac_me'],
    ['is empty', ''],
  ])('rejects a slug that %s', (_label, value) => {
    expect(() => validateSlug(value)).toThrow(FieldValidationError);
  });

  it('rejects a slug over the length ceiling', () => {
    expect(() => validateSlug('a'.repeat(64))).toThrow(FieldValidationError);
  });
});

describe('validateAbsoluteUrl', () => {
  it('accepts an https URL', () => {
    expect(validateAbsoluteUrl('https://example.com')).toBe('https://example.com');
  });

  it('accepts an http URL', () => {
    expect(validateAbsoluteUrl('http://example.com')).toBe('http://example.com');
  });

  it('rejects an unparsable string', () => {
    expect(() => validateAbsoluteUrl('not a url')).toThrow(FieldValidationError);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => validateAbsoluteUrl('ftp://example.com')).toThrow(FieldValidationError);
  });
});

describe('validateDigestPinnedRef', () => {
  it('accepts a tagged, digest-pinned reference', () => {
    const ref = `ghost:6.55.0-alpine@sha256:${DIGEST}`;
    expect(validateDigestPinnedRef(ref)).toBe(ref);
  });

  it('accepts an untagged, digest-pinned reference', () => {
    const ref = `ghost@sha256:${DIGEST}`;
    expect(validateDigestPinnedRef(ref)).toBe(ref);
  });

  it('rejects a reference with a floating tag and no digest', () => {
    expect(() => validateDigestPinnedRef('ghost:6.55.0-alpine')).toThrow(FieldValidationError);
  });

  it('rejects a digest that is not 64 hex characters', () => {
    expect(() => validateDigestPinnedRef('ghost@sha256:abcd')).toThrow(FieldValidationError);
  });
});

describe('validateTenantUid', () => {
  it('accepts the range boundaries', () => {
    expect(validateTenantUid(TENANT_UID_MIN)).toBe(TENANT_UID_MIN);
    expect(validateTenantUid(TENANT_UID_MAX)).toBe(TENANT_UID_MAX);
  });

  it('rejects a uid below the range', () => {
    expect(() => validateTenantUid(TENANT_UID_MIN - 1)).toThrow(FieldValidationError);
  });

  it('rejects a uid above the range', () => {
    expect(() => validateTenantUid(TENANT_UID_MAX + 1)).toThrow(FieldValidationError);
  });

  it('rejects a non-integer uid', () => {
    expect(() => validateTenantUid(30000.5)).toThrow(FieldValidationError);
  });
});

describe('validatePort', () => {
  it('accepts the range boundaries', () => {
    expect(validatePort(1)).toBe(1);
    expect(validatePort(65535)).toBe(65535);
  });

  it('rejects zero', () => {
    expect(() => validatePort(0)).toThrow(FieldValidationError);
  });

  it('rejects a port above 65535', () => {
    expect(() => validatePort(65536)).toThrow(FieldValidationError);
  });

  it('rejects a non-integer port', () => {
    expect(() => validatePort(80.5)).toThrow(FieldValidationError);
  });

  it('names the field in the error when given one', () => {
    let caught: unknown;
    try {
      validatePort(0, 'ports.a');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as InstanceType<typeof FieldValidationError>).field).toBe('ports.a');
  });
});

describe('validatePrivateIpV4', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.254',
  ])('accepts %s', (value) => {
    expect(validatePrivateIpV4(value)).toBe(value);
  });

  it('rejects a public address', () => {
    expect(() => validatePrivateIpV4('8.8.8.8')).toThrow(FieldValidationError);
  });

  it('rejects an address just outside 172.16.0.0/12', () => {
    expect(() => validatePrivateIpV4('172.32.0.1')).toThrow(FieldValidationError);
  });

  it('rejects a non-dotted-quad string', () => {
    expect(() => validatePrivateIpV4('not-an-ip')).toThrow(FieldValidationError);
  });

  it('rejects a non-numeric octet in an otherwise dotted-quad shape', () => {
    expect(() => validatePrivateIpV4('10.0.0.abc')).toThrow(FieldValidationError);
  });

  it('rejects an octet above 255', () => {
    expect(() => validatePrivateIpV4('10.0.0.999')).toThrow(FieldValidationError);
  });

  it('rejects an octet with a leading zero', () => {
    expect(() => validatePrivateIpV4('10.020.1.100')).toThrow(FieldValidationError);
  });

  it('rejects an address with the wrong number of octets', () => {
    expect(() => validatePrivateIpV4('10.0.0')).toThrow(FieldValidationError);
  });
});

describe('validateInstant', () => {
  it('accepts a well-formed UTC instant', () => {
    const value = '2026-09-23T00:00:00.000Z';
    expect(validateInstant(value)).toBe(value);
  });

  it('rejects a non-UTC offset', () => {
    expect(() => validateInstant('2026-09-23T00:00:00+01:00')).toThrow(FieldValidationError);
  });

  it('rejects a date with no time component', () => {
    expect(() => validateInstant('2026-09-23')).toThrow(FieldValidationError);
  });

  it('rejects an unparsable string', () => {
    expect(() => validateInstant('not-a-date')).toThrow(FieldValidationError);
  });
});

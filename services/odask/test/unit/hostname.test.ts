import { describe, expect, it } from 'vitest';
import {
  isEveryInterfaceAddress,
  isSyntacticallyValidHostname,
  normalizeHostname,
} from '../../src/hostname.js';

describe('isSyntacticallyValidHostname', () => {
  it.each([
    'tenant-one.sites.publicpress.co.uk',
    'trypublicpress.co.uk',
    'a.b',
    'x'.repeat(63) + '.example',
    'tenant-one.sites.publicpress.co.uk.', // single trailing dot is a valid FQDN spelling
  ])('accepts %j', (value) => {
    expect(isSyntacticallyValidHostname(value)).toBe(true);
  });

  it.each([
    ['', 'empty string'],
    ['a'.repeat(254), 'over the 253-character ceiling'],
    ['x'.repeat(64) + '.example', 'a label over 63 characters'],
    ['-leading-hyphen.example', 'a label starting with a hyphen'],
    ['trailing-hyphen-.example', 'a label ending with a hyphen'],
    ['double..dot.example', 'an empty label from a double dot'],
    ['..', 'nothing but dots'],
    ['tenant one.example', 'a space'],
    ['tenant_one.example', 'an underscore'],
    ['evil.example/../etc', 'path-traversal-shaped input'],
    ["'; drop table--.example", 'shell/SQL-shaped punctuation'],
    ['a'.repeat(50) + '..' + 'b'.repeat(50), 'a double dot mid-string'],
  ])('refuses %j (%s)', (value) => {
    expect(isSyntacticallyValidHostname(value)).toBe(false);
  });
});

describe('normalizeHostname', () => {
  it('lowercases', () => {
    expect(normalizeHostname('Tenant-One.SITES.publicpress.co.uk')).toBe(
      'tenant-one.sites.publicpress.co.uk'
    );
  });

  it('strips exactly one trailing dot', () => {
    expect(normalizeHostname('tenant-one.example.')).toBe('tenant-one.example');
  });

  it('two spellings of the same SNI value normalize identically', () => {
    const a = normalizeHostname('Tenant-One.Example.');
    const b = normalizeHostname('tenant-one.example');
    expect(a).toBe(b);
  });
});

describe('isEveryInterfaceAddress', () => {
  it.each(['0.0.0.0', '::'])('treats %j as every interface', (address) => {
    expect(isEveryInterfaceAddress(address)).toBe(true);
  });

  it.each(['127.0.0.1', '10.20.1.50', '::1', 'fd00::1', '0.0.0.1', ':::', '0.0.0.0.', ''])(
    'does not treat %j as every interface',
    (address) => {
      expect(isEveryInterfaceAddress(address)).toBe(false);
    }
  );
});

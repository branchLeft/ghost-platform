import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import {
  isSyntacticallyValidHostname,
  normalizeHostname,
  servedHostnameOf,
} from '../../src/hostname.js';

const BASE_DOMAIN = 'sites.publicpress.co.uk';

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

describe('servedHostnameOf', () => {
  it('composes an "ours" descriptor with the configured base domain', () => {
    const descriptor = {
      hostname: { kind: 'ours', sub: 'tenant-one', gated: false },
    } as unknown as TenantDescriptor;
    expect(servedHostnameOf(descriptor, BASE_DOMAIN)).toBe('tenant-one.sites.publicpress.co.uk');
  });

  it('uses a "theirs" descriptor\'s fqdn as-is, normalized', () => {
    const descriptor = {
      hostname: {
        kind: 'theirs',
        fqdn: 'Blog.Trypublicpress.co.uk',
        verifiedAt: '2026-01-01T00:00:00Z',
      },
    } as unknown as TenantDescriptor;
    expect(servedHostnameOf(descriptor, BASE_DOMAIN)).toBe('blog.trypublicpress.co.uk');
  });

  it('never reads baseDomain for a "theirs" descriptor', () => {
    const descriptor = {
      hostname: { kind: 'theirs', fqdn: 'own-domain.example', verifiedAt: '2026-01-01T00:00:00Z' },
    } as unknown as TenantDescriptor;
    // A base domain that would produce a visibly different (wrong) result
    // if it leaked into the "theirs" branch -- proves the branch never
    // touches it rather than merely returning the right answer by luck.
    expect(servedHostnameOf(descriptor, 'poison.invalid')).toBe('own-domain.example');
  });
});

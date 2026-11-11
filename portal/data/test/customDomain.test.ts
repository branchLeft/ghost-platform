import { describe, expect, it } from 'vitest';
import {
  CUSTOM_DOMAIN_FQDN_PATTERN,
  CustomDomainOwnedError,
  InvalidCustomDomainError,
  VERIFICATION_TOKEN_LENGTH,
  VERIFICATION_TOKEN_PATTERN,
  assertOutsideOwnedDomains,
  newVerificationToken,
  normaliseCustomDomain,
  verificationRecordName,
  verificationRecordValue,
} from '../src/customDomain.js';

describe('normalising a custom domain', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['  blog.example.com  ', 'blog.example.com'],
    ['blog.example.com.', 'blog.example.com'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['münchen.example', 'xn--mnchen-3ya.example'],
    ['a-b.c-d.example.co.uk', 'a-b.c-d.example.co.uk'],
  ])('stores %j as %j', (input, stored) => {
    expect(normaliseCustomDomain(input)).toBe(stored);
  });

  it.each([
    undefined,
    null,
    7,
    '',
    '   ',
    'localhost',
    'example',
    '*.example.com',
    'https://example.com',
    'example.com/path',
    'example.com?x=1',
    'example.com#frag',
    'example.com\\evil.test',
    'exa\tmple.com',
    'example.com\nevil.test',
    'example.com:8443',
    'user@example.com',
    '192.0.2.1',
    '2001:db8::1',
    '[2001:db8::1]',
    'exa mple.com',
    'example..com',
    '-example.com',
    'example-.com',
    '.example.com',
    'example.com..',
    'example.123',
    'under_score.example.com',
    `${'a'.repeat(64)}.example.com`,
    `${Array(60).fill('abcd').join('.')}.example.com`,
  ])('refuses %j and does not echo it', (value) => {
    let thrown: unknown;
    try {
      normaliseCustomDomain(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidCustomDomainError);
    if (typeof value === 'string' && value.trim() !== '') {
      expect((thrown as Error).message).not.toContain(value.trim());
    }
  });

  it('accepts a name at the length limit and refuses one over it', () => {
    const label = 'a'.repeat(63);
    const longest = `${label}.${label}.${label}.${'b'.repeat(61)}`;
    expect(longest.length).toBe(253);
    expect(normaliseCustomDomain(longest)).toBe(longest);
    expect(() => normaliseCustomDomain(`${longest}c`)).toThrow(InvalidCustomDomainError);
  });

  it('is exactly the shape the database checks', () => {
    const shape = new RegExp(CUSTOM_DOMAIN_FQDN_PATTERN);
    for (const ok of ['example.com', 'a.b.example.co.uk', 'xn--bcher-kva.example']) {
      expect(shape.test(ok)).toBe(true);
    }
    for (const bad of ['example', 'Example.com', 'example.com.', '1.2.3.4', 'a_b.example.com']) {
      expect(shape.test(bad)).toBe(false);
    }
  });
});

describe('refusing a domain the platform owns', () => {
  const owned = ['platform.example', 'Other-Zone.Example.'];

  it.each([
    'platform.example',
    'sites.platform.example',
    'a.b.platform.example',
    'other-zone.example',
  ])('refuses %s', (fqdn) => {
    expect(() => assertOutsideOwnedDomains(fqdn, owned)).toThrow(CustomDomainOwnedError);
  });

  it.each(['example.com', 'notplatform.example', 'platform.example.net', 'myplatform.example'])(
    'allows %s',
    (fqdn) => {
      expect(() => assertOutsideOwnedDomains(fqdn, owned)).not.toThrow();
    }
  );
});

describe('the one-time verification token', () => {
  it('is 32 characters of the base32 alphabet, which is also what the database accepts', () => {
    const token = newVerificationToken();
    expect(token).toHaveLength(VERIFICATION_TOKEN_LENGTH);
    expect(new RegExp(VERIFICATION_TOKEN_PATTERN).test(token)).toBe(true);
  });

  it('is drawn fresh from the random source and takes nothing from the caller', () => {
    expect(newVerificationToken()).not.toBe(newVerificationToken());
    const bytes = (size: number) => new Uint8Array(size).fill(0);
    expect(newVerificationToken(bytes)).toBe('a'.repeat(32));
    const high = (size: number) => new Uint8Array(size).fill(255);
    expect(newVerificationToken(high)).toBe('7'.repeat(32));
  });

  it('names the record to set and what it holds', () => {
    expect(verificationRecordName('example.com')).toBe('_publicpress-verify.example.com');
    expect(verificationRecordValue('abc')).toBe('publicpress-verify=abc');
  });
});

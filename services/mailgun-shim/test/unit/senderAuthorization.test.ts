import { describe, expect, it, vi } from 'vitest';
import { resolveSenderDomain, senderBelongsToTenant } from '../../src/senderAuthorization.js';
import type { Logger } from '../../src/log.js';
import {
  DOMAIN_EDGE_WHITESPACE,
  hostnameControlRows,
  nonHostnameRows,
} from './helpers/senderDomainRows.js';

describe('senderBelongsToTenant', () => {
  it('accepts an exact-match bare address', () => {
    expect(senderBelongsToTenant('a@tenant.example.com', 'tenant.example.com')).toBe(true);
  });

  it('refuses an unrelated domain', () => {
    expect(senderBelongsToTenant('a@evil.example', 'tenant.example.com')).toBe(false);
  });

  it('compares the domain case-insensitively', () => {
    expect(senderBelongsToTenant('a@TENANT.example.com', 'tenant.example.com')).toBe(true);
    expect(senderBelongsToTenant('a@tenant.example.com', 'TENANT.EXAMPLE.COM')).toBe(true);
  });

  it('reads the address out from under a display name', () => {
    expect(senderBelongsToTenant('Tenant Name <a@tenant.example.com>', 'tenant.example.com')).toBe(
      true
    );
    expect(senderBelongsToTenant('Tenant Name <a@evil.example>', 'tenant.example.com')).toBe(false);
  });

  it('handles a quoted local part, including one that itself contains "@"', () => {
    expect(senderBelongsToTenant('"a b"@tenant.example.com', 'tenant.example.com')).toBe(true);
    // The quoted local part contains an '@' — a naive first-"@" split would
    // misread the domain as "b"; addressparser's quoting-aware parse must
    // still land on the real domain after the LAST, unquoted '@'.
    expect(senderBelongsToTenant('"a@b"@tenant.example.com', 'tenant.example.com')).toBe(true);
    expect(senderBelongsToTenant('"a@b"@evil.example', 'tenant.example.com')).toBe(false);
  });

  it('requires every address in a multi-address header to belong, refusing a mix of real and foreign', () => {
    expect(
      senderBelongsToTenant('a@tenant.example.com, b@tenant.example.com', 'tenant.example.com')
    ).toBe(true);
    expect(
      senderBelongsToTenant('a@tenant.example.com, b@evil.example', 'tenant.example.com')
    ).toBe(false);
    expect(
      senderBelongsToTenant('b@evil.example, a@tenant.example.com', 'tenant.example.com')
    ).toBe(false);
  });

  it('refuses an empty or null sender rather than treating "nothing found" as harmless', () => {
    expect(senderBelongsToTenant('', 'tenant.example.com')).toBe(false);
    expect(senderBelongsToTenant('   ', 'tenant.example.com')).toBe(false);
    expect(senderBelongsToTenant(null, 'tenant.example.com')).toBe(false);
    expect(senderBelongsToTenant(undefined, 'tenant.example.com')).toBe(false);
  });

  it('refuses a header that parses to no mailbox at all (an empty group)', () => {
    expect(senderBelongsToTenant('undisclosed-recipients:;', 'tenant.example.com')).toBe(false);
  });

  it('matches an IDN domain against its punycode form in either direction', () => {
    // straße.example <-> xn--strae-oqa.example is the standard worked
    // example for this exact normalisation (verified against Node's own
    // domainToASCII rather than assumed).
    expect(senderBelongsToTenant('a@xn--strae-oqa.example', 'straße.example')).toBe(true);
    expect(senderBelongsToTenant('a@straße.example', 'xn--strae-oqa.example')).toBe(true);
  });

  it('ignores a trailing root dot on either side', () => {
    expect(senderBelongsToTenant('a@tenant.example.com.', 'tenant.example.com')).toBe(true);
    expect(senderBelongsToTenant('a@tenant.example.com', 'tenant.example.com.')).toBe(true);
  });

  it('refuses a look-alike domain that merely contains the tenant domain as a substring', () => {
    // A suffix/endsWith check would be fooled by this shape.
    expect(senderBelongsToTenant('a@tenant.example.com.evil.example', 'tenant.example.com')).toBe(
      false
    );
    // ...and this one the other way round, if the comparison were ever
    // "tenant domain contains the claimed domain" instead of equality.
    expect(senderBelongsToTenant('a@example.com', 'tenant.example.com')).toBe(false);
  });

  it('refuses a look-alike domain that merely shares the tenant name as a substring of a different domain', () => {
    expect(senderBelongsToTenant('a@eviltenant.example.com', 'tenant.example.com')).toBe(false);
  });

  it('refuses a genuine subdomain of the tenant domain — exact match only, no wildcarding', () => {
    expect(senderBelongsToTenant('a@mail.tenant.example.com', 'tenant.example.com')).toBe(false);
  });

  it('refuses an address with no domain at all', () => {
    expect(senderBelongsToTenant('not-an-address', 'tenant.example.com')).toBe(false);
    expect(senderBelongsToTenant('a@', 'tenant.example.com')).toBe(false);
  });

  it('refuses when the stored tenant domain itself is unparseable', () => {
    expect(senderBelongsToTenant('a@tenant.example.com', '')).toBe(false);
  });
});

describe('senderBelongsToTenant — the sender domain is compared as a hostname', () => {
  const TENANT = 'tenant-a.example.com';

  it.each(nonHostnameRows(TENANT))('refuses $label', ({ from }) => {
    expect(senderBelongsToTenant(from, TENANT)).toBe(false);
  });

  it.each(hostnameControlRows(TENANT))('CONTROL: accepts $label', ({ from }) => {
    expect(senderBelongsToTenant(from, TENANT)).toBe(true);
  });

  it('refuses every ASCII character that is not valid in a hostname, wherever it sits in the stored domain', () => {
    const hostnameChars = /[A-Za-z0-9._-]/;
    const letThrough: string[] = [];
    for (let code = 0; code < 0x80; code++) {
      const ch = String.fromCharCode(code);
      if (hostnameChars.test(ch)) {
        continue;
      }
      for (const stored of [`${TENANT}${ch}`, `${ch}${TENANT}`, `tenant-a${ch}.example.com`]) {
        if (senderBelongsToTenant(`alice@${TENANT}`, stored)) {
          letThrough.push(`${JSON.stringify(ch)} in ${JSON.stringify(stored)}`);
        }
      }
    }
    // Any entry here is a character the comparison let through.
    expect(letThrough).toEqual([]);
  });

  it('refuses a stored domain that only becomes a hostname once whitespace is trimmed', () => {
    for (const space of DOMAIN_EDGE_WHITESPACE) {
      expect(senderBelongsToTenant(`alice@${TENANT}`, `${space}${TENANT}`)).toBe(false);
      expect(senderBelongsToTenant(`alice@${TENANT}`, `${TENANT}${space}`)).toBe(false);
    }
  });

  it('refuses a non-ASCII character that the IDNA mapping turns into a character a hostname cannot hold, on both sides alike', () => {
    // Each maps to ';', '!!', '+' and '(1)' respectively. The same value on
    // both sides would otherwise compare equal as the same non-hostname.
    for (const codePoint of [0x037e, 0x203c, 0x207a, 0x2474]) {
      const domain = `tenant-a${String.fromCodePoint(codePoint)}.example.com`;
      expect(senderBelongsToTenant(`alice@${domain}`, domain)).toBe(false);
    }
  });

  it('CONTROL: still compares an internationalised domain with its punycode form, in mixed case', () => {
    expect(senderBelongsToTenant('alice@Straße.Example', 'xn--strae-oqa.example')).toBe(true);
    expect(senderBelongsToTenant('alice@XN--STRAE-OQA.example', 'straße.example')).toBe(true);
    expect(senderBelongsToTenant('alice@bücher.example', 'xn--bcher-kva.example')).toBe(true);
  });

  it('CONTROL: a tenant registered at a subdomain matches exactly that subdomain and not its parent', () => {
    expect(
      senderBelongsToTenant('alice@news.tenant-a.example.com', 'news.tenant-a.example.com')
    ).toBe(true);
    expect(senderBelongsToTenant('alice@tenant-a.example.com', 'news.tenant-a.example.com')).toBe(
      false
    );
  });

  it('CONTROL: accepts the characters a hostname may hold, hyphen, underscore and digits', () => {
    expect(senderBelongsToTenant('alice@a-b_c1.example.com', 'a-b_c1.example.com')).toBe(true);
  });
});

function fakeLogger(): Logger {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('resolveSenderDomain', () => {
  it("returns the tenant's registered sender domain when one is set", () => {
    const log = fakeLogger();
    expect(
      resolveSenderDomain(
        { domain: 'blog.branchleft.co.uk', senderDomain: 'branchleft.co.uk' },
        log,
        'http'
      )
    ).toBe('branchleft.co.uk');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('fails closed (returns null, never the credential key) for a tenant with no registered sender domain, logging which tenant and route', () => {
    const log = fakeLogger();
    const result = resolveSenderDomain(
      { domain: 'blog.branchleft.co.uk', senderDomain: null },
      log,
      'smtp'
    );
    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith('sender_domain_not_registered', {
      domain: 'blog.branchleft.co.uk',
      route: 'smtp',
    });
  });

  it('never falls back to tenant.domain (the credential key) when senderDomain is unset', () => {
    const log = fakeLogger();
    const result = resolveSenderDomain(
      { domain: 'blog.branchleft.co.uk', senderDomain: null },
      log,
      'http'
    );
    expect(result).not.toBe('blog.branchleft.co.uk');
    expect(result).toBeNull();
  });
});

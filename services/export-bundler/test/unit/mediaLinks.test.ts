import { describe, expect, it } from 'vitest';
import {
  assertSafeObjectKey,
  MAX_LINK_TTL_SECONDS,
  MediaLinkError,
  signMediaLink,
  verifyMediaLink,
  type MediaLinkSigner,
} from '../../src/mediaLinks.js';

const SECRET = Buffer.alloc(32, 9);
const NOW = 1_800_000_000;
const signer: MediaLinkSigner = {
  baseUrl: 'https://export.test',
  ttlSeconds: 3600,
  secret: SECRET,
};

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MediaLinkError) return err.reason;
    throw err;
  }
  return 'no-error';
}

describe('signMediaLink and verifyMediaLink', () => {
  it('round-trips a link for the tenant and key it was signed for', () => {
    const { url, expiresAt } = signMediaLink(signer, 'tenant-1', '2026/a b.png', NOW);
    expect(expiresAt).toBe(NOW + 3600);
    expect(verifyMediaLink(SECRET, url, NOW, 'tenant-1')).toEqual({
      tenantId: 'tenant-1',
      key: '2026/a b.png',
      expiresAt: NOW + 3600,
    });
  });

  it('EXPIRES: valid one second before the deadline, refused at it and after it', () => {
    const { url, expiresAt } = signMediaLink(signer, 'tenant-1', 'a.png', NOW);
    expect(reason(() => verifyMediaLink(SECRET, url, expiresAt - 1))).toBe('no-error');
    expect(reason(() => verifyMediaLink(SECRET, url, expiresAt))).toBe('expired');
    expect(reason(() => verifyMediaLink(SECRET, url, expiresAt + 86_400))).toBe('expired');
  });

  it('cannot be extended by editing the expiry', () => {
    const { url, expiresAt } = signMediaLink(signer, 'tenant-1', 'a.png', NOW);
    const extended = url.replace(`expires=${expiresAt}`, `expires=${expiresAt + 99_999}`);
    expect(reason(() => verifyMediaLink(SECRET, extended, NOW))).toBe('bad-signature');
  });

  it('cannot be replayed for another object or another tenant', () => {
    const { url } = signMediaLink(signer, 'tenant-1', 'a.png', NOW);
    expect(reason(() => verifyMediaLink(SECRET, url.replace('a.png', 'b.png'), NOW))).toBe(
      'bad-signature'
    );
    expect(
      reason(() => verifyMediaLink(SECRET, url.replace('/tenant-1/', '/tenant-2/'), NOW))
    ).toBe('bad-signature');
  });

  it('refuses a link whose tenant is not the tenant expected', () => {
    const { url } = signMediaLink(signer, 'tenant-1', 'a.png', NOW);
    expect(reason(() => verifyMediaLink(SECRET, url, NOW, 'tenant-2'))).toBe('wrong-tenant');
  });

  it('refuses a link signed under a different secret', () => {
    const { url } = signMediaLink(signer, 'tenant-1', 'a.png', NOW);
    expect(reason(() => verifyMediaLink(Buffer.alloc(32, 1), url, NOW))).toBe('bad-signature');
  });

  it.each([
    ['not a URL', 'nonsense'],
    ['no query', 'https://export.test/tenant-1/a.png'],
    ['a short signature', 'https://export.test/tenant-1/a.png?expires=1&sig=ab'],
    ['no key', `https://export.test/tenant-1?expires=1&sig=${'a'.repeat(64)}`],
    ['a non-numeric expiry', `https://export.test/tenant-1/a.png?expires=x&sig=${'a'.repeat(64)}`],
    [
      'a traversal key',
      `https://export.test/tenant-1/%2e%2e/a.png?expires=1&sig=${'a'.repeat(64)}`,
    ],
    ['a bad tenant id', `https://export.test/TENANT/a.png?expires=1&sig=${'a'.repeat(64)}`],
    [
      'an undecodable path',
      `https://export.test/tenant-1/%E0%A4%A?expires=1&sig=${'a'.repeat(64)}`,
    ],
  ])('refuses a malformed link: %s', (_label, link) => {
    expect(reason(() => verifyMediaLink(SECRET, link, NOW))).toBe('malformed');
  });

  it('refuses to sign with a weak secret, a bad lifetime or a base that is not a bare https origin', () => {
    const sign = (s: Partial<MediaLinkSigner>) => () =>
      signMediaLink({ ...signer, ...s }, 'tenant-1', 'a.png', NOW);
    expect(reason(sign({ secret: Buffer.alloc(31) }))).toBe('weak-secret');
    expect(reason(sign({ ttlSeconds: 59 }))).toBe('bad-ttl');
    expect(reason(sign({ ttlSeconds: MAX_LINK_TTL_SECONDS + 1 }))).toBe('bad-ttl');
    expect(reason(sign({ ttlSeconds: 1.5 }))).toBe('bad-ttl');
    expect(reason(sign({ baseUrl: 'http://export.test' }))).toBe('bad-base-url');
    expect(reason(sign({ baseUrl: 'https://export.test/x' }))).toBe('bad-base-url');
    expect(reason(sign({ baseUrl: 'https://export.test/?a=1' }))).toBe('bad-base-url');
    expect(reason(sign({ baseUrl: 'not a url' }))).toBe('bad-base-url');
    expect(reason(sign({}))).toBe('no-error');
    expect(reason(() => signMediaLink(signer, 'Bad Tenant', 'a.png', NOW))).toBe('malformed');
  });
});

describe('assertSafeObjectKey', () => {
  it.each([
    '',
    '/a',
    'a//b',
    'a/./b',
    'a/../b',
    '..',
    'a\\b',
    'a%2Fb',
    'a/%2e%2E/b',
    'a\u0000b',
    'a?b',
    'a#b',
    'x'.repeat(1025),
  ])('refuses %j', (key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(MediaLinkError);
  });

  it('accepts an ordinary object key', () => {
    expect(() => assertSafeObjectKey('2026/10/photo-1.png')).not.toThrow();
  });
});

describe('the signed message encoding', () => {
  it('matches a fixed known-answer vector, so a verifying route cannot diverge from the signer', () => {
    const { url } = signMediaLink(signer, 't1', '0x/a.png', NOW);
    expect(url).toBe(
      'https://export.test/t1/0x/a.png?expires=1800003600&sig=a286beaa9254cdd7fb2e9a8983ab6450d86fd513315e11dedfdb47bb04fcc1c5'
    );
  });

  it('does not let a link for t1 / 0x/a.png pass as t10 / x/a.png (field boundary shift)', () => {
    const { url } = signMediaLink(signer, 't1', '0x/a.png', NOW);
    const shifted = url.replace('/t1/0x/a.png', '/t10/x/a.png');
    expect(reason(() => verifyMediaLink(SECRET, shifted, NOW))).toBe('bad-signature');
  });

  it('does not let key a1 at expiry E pass as key a at expiry 1E (key and expiry boundary shift)', () => {
    const { url, expiresAt } = signMediaLink(signer, 't1', 'a1', NOW);
    const shifted = url
      .replace('/a1?', '/a?')
      .replace(`expires=${expiresAt}`, `expires=1${expiresAt}`);
    expect(reason(() => verifyMediaLink(SECRET, shifted, NOW))).toBe('bad-signature');
  });

  it('binds the expiry exactly: one second either side of the signed value fails the signature', () => {
    const { url, expiresAt } = signMediaLink(signer, 't1', 'a.png', NOW);
    for (const moved of [expiresAt - 1, expiresAt + 1]) {
      expect(
        reason(() =>
          verifyMediaLink(SECRET, url.replace(`expires=${expiresAt}`, `expires=${moved}`), NOW)
        )
      ).toBe('bad-signature');
    }
  });
});

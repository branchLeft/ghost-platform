import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenVerifier } from '../src/verifier.js';
import type { Jwk, TokenVerifierOptions } from '../src/verifier.js';
import { CLAIM_PROJECT_ROLES, CLAIM_RESOURCE_OWNER } from '../src/tokens.js';

const ISSUER = 'https://id.example.test';
const NOW = 1_800_000_000;

function keyPair(bits = 2048): { privateKey: KeyObject; jwk: Jwk } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const exported = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return {
    privateKey,
    jwk: { kty: 'RSA', n: exported.n, e: exported.e, kid: 'k1', use: 'sig', alg: 'RS256' },
  };
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const claims = {
  iss: ISSUER,
  aud: ['app', 'peer', 'project'],
  client_id: 'app',
  sub: 'user-1',
  exp: NOW + 600,
  [CLAIM_RESOURCE_OWNER]: 'org-a',
  [CLAIM_PROJECT_ROLES]: { 'tenant-admin': { 'org-a': 'a.example.test' } },
};

function sign(
  privateKey: KeyObject,
  options: { header?: Record<string, unknown>; payload?: unknown; digest?: string } = {}
): string {
  const header = b64({ alg: 'RS256', kid: 'k1', typ: 'at+jwt', ...options.header });
  const payload = b64(options.payload ?? claims);
  const signer = createSign(options.digest ?? 'RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

function verifier(keys: () => Promise<readonly Jwk[]>, extra: Partial<TokenVerifierOptions> = {}) {
  return createTokenVerifier({
    issuer: ISSUER,
    clientId: 'app',
    requiredRole: 'tenant-admin',
    allowedOrgIds: new Set(['org-a']),
    fetchKeys: keys,
    clock: () => NOW,
    ...extra,
  });
}

describe('createTokenVerifier', () => {
  const { privateKey, jwk } = keyPair();
  const keys = async (): Promise<readonly Jwk[]> => [jwk];

  it('accepts a correctly signed token for this application', async () => {
    expect(await verifier(keys).verify(sign(privateKey))).toEqual({
      ok: true,
      orgId: 'org-a',
      subject: 'user-1',
    });
  });

  it('refuses a token signed by a different key, and one whose payload was changed after signing', async () => {
    const other = keyPair().privateKey;
    expect(await verifier(keys).verify(sign(other))).toEqual({
      ok: false,
      reason: 'token signature is invalid',
    });

    const good = sign(privateKey).split('.');
    const swapped = [good[0], b64({ ...claims, [CLAIM_RESOURCE_OWNER]: 'org-b' }), good[2]].join(
      '.'
    );
    expect(await verifier(keys).verify(swapped)).toEqual({
      ok: false,
      reason: 'token signature is invalid',
    });
  });

  it('refuses a signature segment that is not base64url', async () => {
    const [h, p] = sign(privateKey).split('.');
    expect(await verifier(keys).verify(`${h}.${p}.@@@`)).toEqual({
      ok: false,
      reason: 'token signature is invalid',
    });
  });

  it('refuses every algorithm but the pinned one, even when validly signed', async () => {
    const rs512 = sign(privateKey, { header: { alg: 'RS512' }, digest: 'RSA-SHA512' });
    expect(await verifier(keys).verify(rs512)).toEqual({
      ok: false,
      reason: 'signing algorithm is not accepted',
    });
    // The pin is a setting: widening it is what admits the same token.
    const unpinnedKey: Jwk = { kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'k1' };
    const widened = verifier(async () => [unpinnedKey], { algorithms: ['RS256', 'RS512'] });
    expect((await widened.verify(rs512)).ok).toBe(true);
  });

  it('refuses alg none, with and without a signature', async () => {
    const header = b64({ alg: 'none', kid: 'k1' });
    const payload = b64(claims);
    for (const token of [`${header}.${payload}.`, `${header}.${payload}.AAAA`]) {
      expect((await verifier(keys).verify(token)).ok).toBe(false);
    }
    // Even if an operator listed it, there is no verifier for it.
    expect(
      (await verifier(keys, { algorithms: ['none'] }).verify(`${header}.${payload}.AAAA`)).ok
    ).toBe(false);
  });

  it('refuses an HMAC token signed with the public key as the secret (algorithm confusion)', async () => {
    const header = b64({ alg: 'HS256', kid: 'k1' });
    const payload = b64(claims);
    const secret = Buffer.from(JSON.stringify(jwk));
    const mac = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    const token = `${header}.${payload}.${mac}`;
    expect(await verifier(keys).verify(token)).toEqual({
      ok: false,
      reason: 'signing algorithm is not accepted',
    });
    expect((await verifier(keys, { algorithms: ['HS256'] }).verify(token)).ok).toBe(false);
  });

  it('refuses a token with no key id, an unpublished key id, or a critical header', async () => {
    expect(await verifier(keys).verify(sign(privateKey, { header: { kid: undefined } }))).toEqual({
      ok: false,
      reason: 'token names no signing key',
    });
    expect(
      await verifier(keys)
        .verify(sign(privateKey, { header: { kid: '' } }))
        .then((v) => v.ok)
    ).toBe(false);
    expect(await verifier(keys).verify(sign(privateKey, { header: { kid: 'ghost' } }))).toEqual({
      ok: false,
      reason: 'signing key is not published',
    });
    expect(await verifier(keys).verify(sign(privateKey, { header: { crit: ['x'] } }))).toEqual({
      ok: false,
      reason: 'token carries unsupported critical headers',
    });
  });

  it('refuses a published key that is not a usable signing RSA key', async () => {
    const wrong: Jwk[] = [
      { ...jwk, kty: 'EC' },
      { ...jwk, use: 'enc' },
      { ...jwk, alg: 'RS512' },
      { ...jwk, n: undefined },
      { ...jwk, n: '!!!' },
      { ...keyPair(1024).jwk },
    ];
    for (const key of wrong) {
      const result = await verifier(async () => [key]).verify(sign(privateKey));
      expect(result).toEqual({ ok: false, reason: 'signing key is not usable' });
    }
  });

  it('accepts a key that omits use and alg', async () => {
    const bare: Jwk = { kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'k1' };
    expect((await verifier(async () => [bare]).verify(sign(privateKey))).ok).toBe(true);
  });

  it('refuses malformed tokens of every shape', async () => {
    const v = verifier(keys);
    const [h, p, s] = sign(privateKey).split('.') as [string, string, string];
    const cases = [
      '',
      'a.b',
      'a.b.c.d',
      `${h}.${p}.${s}.x`,
      `!!.${p}.${s}`,
      `${b64([])}.${p}.${s}`,
      `${b64('x')}.${p}.${s}`,
      `${Buffer.from('not json').toString('base64url')}.${p}.${s}`,
      'x'.repeat(16 * 1024 + 1),
    ];
    for (const token of cases) expect((await v.verify(token)).ok).toBe(false);
    expect((await v.verify(undefined as unknown as string)).ok).toBe(false);
  });

  it('refuses a signed payload that is not a JSON object', async () => {
    const header = b64({ alg: 'RS256', kid: 'k1' });
    const payload = b64([1]);
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const token = `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
    expect(await verifier(keys).verify(token)).toEqual({ ok: false, reason: 'token is malformed' });
  });

  it('passes the claims through the application and organisation checks', async () => {
    expect(await verifier(keys, { clientId: 'peer' }).verify(sign(privateKey))).toEqual({
      ok: false,
      reason: 'token was issued to a different application',
    });
    expect(
      await verifier(keys, { allowedOrgIds: new Set(['org-z']) }).verify(sign(privateKey))
    ).toEqual({
      ok: false,
      reason: 'organisation is not permitted here',
    });
    expect((await verifier(keys, { clock: () => NOW + 10_000 }).verify(sign(privateKey))).ok).toBe(
      false
    );
  });

  it('refuses, with a fixed reason, when the key set cannot be fetched', async () => {
    const failing = verifier(async () => {
      throw new Error('secret detail');
    });
    expect(await failing.verify(sign(privateKey))).toEqual({
      ok: false,
      reason: 'token could not be verified',
    });
  });

  it('fetches keys once for known ids, and refetches an unknown id no more than once per interval', async () => {
    let calls = 0;
    let now = NOW;
    const counting = verifier(
      async () => {
        calls += 1;
        return [jwk];
      },
      { clock: () => now, minRefetchSeconds: 10 }
    );
    await counting.verify(sign(privateKey));
    await counting.verify(sign(privateKey));
    expect(calls).toBe(1);
    const unknown = sign(privateKey, { header: { kid: 'new' } });
    await counting.verify(unknown);
    await counting.verify(unknown);
    expect(calls).toBe(1);
    now += 11;
    await counting.verify(unknown);
    expect(calls).toBe(2);
  });

  it('picks up a rotated key once the interval has passed', async () => {
    const next = keyPair();
    let published: Jwk[] = [jwk];
    let now = NOW;
    const v = verifier(async () => published, { clock: () => now, minRefetchSeconds: 10 });
    expect((await v.verify(sign(privateKey))).ok).toBe(true);
    published = [jwk, { ...next.jwk, kid: 'k2' }];
    now += 11;
    expect((await v.verify(sign(next.privateKey, { header: { kid: 'k2' } }))).ok).toBe(true);
  });

  it('reads the issuer’s own key endpoint by default, and refuses when it errors', async () => {
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }) as unknown as typeof fetch;
    try {
      const v = createTokenVerifier({
        issuer: ISSUER,
        clientId: 'app',
        requiredRole: 'tenant-admin',
        allowedOrgIds: new Set(['org-a']),
        clock: () => NOW,
      });
      expect((await v.verify(sign(privateKey))).ok).toBe(true);
      expect(urls).toEqual([`${ISSUER}/oauth/v2/keys`]);

      globalThis.fetch = (async () => ({
        ok: false,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      const down = createTokenVerifier({
        issuer: ISSUER,
        clientId: 'app',
        requiredRole: 'tenant-admin',
        allowedOrgIds: new Set(['org-a']),
      });
      expect((await down.verify(sign(privateKey))).ok).toBe(false);

      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ keys: 'no' }),
      })) as unknown as typeof fetch;
      const odd = createTokenVerifier({
        issuer: ISSUER,
        clientId: 'app',
        requiredRole: 'tenant-admin',
        allowedOrgIds: new Set(['org-a']),
      });
      expect(await odd.verify(sign(privateKey))).toEqual({
        ok: false,
        reason: 'signing key is not published',
      });
    } finally {
      globalThis.fetch = real;
    }
  });
});

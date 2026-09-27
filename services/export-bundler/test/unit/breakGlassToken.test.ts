import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBreakGlassMinter } from '../../src/breakGlassToken.js';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const rawPrivate = privDer.subarray(privDer.length - 32);
  return { publicKey, rawPrivate };
}

function decode(token: string): {
  body: string;
  signature: Buffer;
  claims: Record<string, unknown>;
} {
  const [body, signature] = token.split('.');
  return {
    body: body!,
    signature: Buffer.from(signature!, 'base64url'),
    claims: JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')),
  };
}

describe('createBreakGlassMinter', () => {
  it("produces a token adapters/sso/src/break-glass.js's own verify accepts: valid Ed25519 signature over the exact ASCII body", () => {
    const { publicKey, rawPrivate } = keypair();
    const minter = createBreakGlassMinter(
      rawPrivate,
      'tenant-1',
      'support@tenant-1.example',
      60,
      () => 1_000
    );
    const { body, signature } = decode(minter.mint());

    expect(cryptoVerify(null, Buffer.from(body, 'ascii'), publicKey, signature)).toBe(true);
  });

  it('sets sub/aud from the identity and tenant given, and exp = iat + ttl', () => {
    const { rawPrivate } = keypair();
    const minter = createBreakGlassMinter(
      rawPrivate,
      'tenant-1',
      'support@tenant-1.example',
      45,
      () => 1_000
    );
    const { claims } = decode(minter.mint());

    expect(claims).toMatchObject({
      sub: 'support@tenant-1.example',
      aud: 'tenant-1',
      iat: 1_000,
      exp: 1_045,
    });
    expect(typeof claims.jti).toBe('string');
    expect((claims.jti as string).length).toBeGreaterThan(0);
  });

  it('mints a fresh, unpredictable jti on every call -- the adapter refuses a replayed jti', () => {
    const { rawPrivate } = keypair();
    const minter = createBreakGlassMinter(rawPrivate, 'tenant-1', 'support@tenant-1.example');
    const a = decode(minter.mint()).claims.jti;
    const b = decode(minter.mint()).claims.jti;
    expect(a).not.toBe(b);
  });

  it('refuses a private key that is not exactly 32 raw bytes -- fails loudly rather than minting an unverifiable token', () => {
    expect(() =>
      createBreakGlassMinter(Buffer.alloc(16), 'tenant-1', 'support@tenant-1.example')
    ).toThrow();
  });

  it('a token minted for one tenant fails the audience check a token for another tenant would need to pass', () => {
    const { rawPrivate } = keypair();
    const a = createBreakGlassMinter(
      rawPrivate,
      'tenant-1',
      'support@tenant-1.example',
      60,
      () => 1_000
    );
    const b = createBreakGlassMinter(
      rawPrivate,
      'tenant-2',
      'support@tenant-1.example',
      60,
      () => 1_000
    );
    expect(decode(a.mint()).claims.aud).not.toBe(decode(b.mint()).claims.aud);
  });
});

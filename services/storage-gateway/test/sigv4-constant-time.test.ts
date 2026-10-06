import { beforeEach, describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({ calls: [] as [Buffer, Buffer, boolean][] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      const result = actual.timingSafeEqual(a, b);
      spy.calls.push([Buffer.from(a), Buffer.from(b), result]);
      return result;
    },
  };
});

const { referenceSign, sha256Hex } = await import('./support/reference-signer.js');
const { IDENTITY, authOf, makeVerifier, withAuth } = await import('./support/verifier-fixtures.js');

const SPEC = {
  method: 'PUT',
  path: '/media-shard-a/q7f3k2m9x1/photo.png',
  query: { 'x-id': 'PutObject' },
  headers: { host: 'storage-gateway.internal:8443' },
  body: 'BODY',
  payloadHash: sha256Hex('BODY'),
};

function providedSignature(auth: string): Buffer {
  return Buffer.from(/Signature=([0-9a-f]{64})$/.exec(auth)?.[1] ?? '', 'hex');
}

describe('signature comparison', () => {
  beforeEach(() => {
    spy.calls.length = 0;
  });

  it('compares the presented signature in constant time, and accepts on its verdict', async () => {
    const { request } = await referenceSign(SPEC, IDENTITY);
    const r = await makeVerifier().verifyDetailed(request);
    expect(r.ok).toBe(true);
    const provided = providedSignature(authOf(request));
    const sigCall = spy.calls.find(([, b]) => b.equals(provided));
    expect(sigCall, 'timingSafeEqual was never given the presented signature').toBeDefined();
    expect(sigCall?.[0].equals(provided)).toBe(true);
    expect(sigCall?.[2]).toBe(true);
  });

  it('refuses a wrong signature through the constant-time comparison', async () => {
    const { request } = await referenceSign(SPEC, IDENTITY);
    const auth = authOf(request);
    const wrong = auth.slice(0, -1) + (auth.endsWith('0') ? '1' : '0');
    const r = await makeVerifier().verifyDetailed(withAuth(request, wrong));
    expect(r).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    const provided = providedSignature(wrong);
    const sigCall = spy.calls.find(([, b]) => b.equals(provided));
    expect(sigCall, 'timingSafeEqual was never given the presented signature').toBeDefined();
    expect(sigCall?.[2]).toBe(false);
  });

  it('compares the body digest in constant time too', async () => {
    const { request } = await referenceSign(SPEC, IDENTITY);
    await makeVerifier().verifyDetailed(request);
    const digest = Buffer.from(sha256Hex('BODY'), 'hex');
    expect(spy.calls.some(([a, b]) => a.equals(digest) && b.equals(digest))).toBe(true);
  });
});

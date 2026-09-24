import { describe, expect, it } from 'vitest';
import { verifyRequest } from '../../src/auth.js';
import { createInMemoryNonceStore } from '../../src/nonceStore.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';

function deps(nowMs: number, keyPair = generateTestKeyPair(), windowSeconds = 60) {
  return {
    keyPair,
    deps: {
      verifyKey: keyPair.publicKeyRaw,
      replayWindowSeconds: windowSeconds,
      nonces: createInMemoryNonceStore(windowSeconds * 1000),
      nowMs: () => nowMs,
    },
  };
}

describe('verifyRequest', () => {
  it('admits a correctly signed, fresh request', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs);
    const body = Buffer.from('{"slot":"0"}');
    const headers = signHeaders(keyPair, 'POST', '/reconcile', body, Math.floor(nowMs / 1000));
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      {
        timestamp: headers['X-Broker-Timestamp'],
        nonce: headers['X-Broker-Nonce'],
        signature: headers['X-Broker-Signature'],
      },
      body
    );
    expect(result).toEqual({ ok: true });
  });

  it('refuses a request signed too far in the past', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs, undefined, 60);
    const body = Buffer.from('{}');
    const staleSeconds = Math.floor(nowMs / 1000) - 120;
    const headers = signHeaders(keyPair, 'POST', '/reconcile', body, staleSeconds);
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      {
        timestamp: headers['X-Broker-Timestamp'],
        nonce: headers['X-Broker-Nonce'],
        signature: headers['X-Broker-Signature'],
      },
      body
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a request signed too far in the future', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs, undefined, 60);
    const body = Buffer.from('{}');
    const futureSeconds = Math.floor(nowMs / 1000) + 30;
    const headers = signHeaders(keyPair, 'POST', '/reconcile', body, futureSeconds);
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      {
        timestamp: headers['X-Broker-Timestamp'],
        nonce: headers['X-Broker-Nonce'],
        signature: headers['X-Broker-Signature'],
      },
      body
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a replayed nonce even with an otherwise valid signature', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs);
    const body = Buffer.from('{}');
    const headers = signHeaders(keyPair, 'POST', '/reconcile', body, Math.floor(nowMs / 1000));
    const first = verifyRequest(
      d,
      'POST',
      '/reconcile',
      {
        timestamp: headers['X-Broker-Timestamp'],
        nonce: headers['X-Broker-Nonce'],
        signature: headers['X-Broker-Signature'],
      },
      body
    );
    const second = verifyRequest(
      d,
      'POST',
      '/reconcile',
      {
        timestamp: headers['X-Broker-Timestamp'],
        nonce: headers['X-Broker-Nonce'],
        signature: headers['X-Broker-Signature'],
      },
      body
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('refuses a request missing the signature header', () => {
    const nowMs = 1_700_000_000_000;
    const { deps: d } = deps(nowMs);
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      { timestamp: '1700000000', nonce: 'n'.repeat(16) },
      Buffer.from('{}')
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a malformed nonce shape before ever claiming it', () => {
    const nowMs = 1_700_000_000_000;
    const { deps: d } = deps(nowMs);
    const body = Buffer.from('{}');
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      { timestamp: String(Math.floor(nowMs / 1000)), nonce: 'short', signature: 'irrelevant' },
      body
    );
    expect(result.ok).toBe(false);
    // The malformed nonce must not have been claimed -- a legitimately
    // signed retry with the same (illegal) nonce would still be refused by
    // shape, but this proves the store was never touched for it.
    expect(d.nonces.claim('short', nowMs)).toBe(true);
  });

  it('refuses a request whose signature does not match, even with a valid timestamp and fresh nonce', () => {
    const nowMs = 1_700_000_000_000;
    const { deps: d } = deps(nowMs);
    const other = generateTestKeyPair();
    const body = Buffer.from('{}');
    const headers = signHeaders(other, 'POST', '/reconcile', body, Math.floor(nowMs / 1000));
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      {
        timestamp: headers['X-Broker-Timestamp'],
        nonce: headers['X-Broker-Nonce'],
        signature: headers['X-Broker-Signature'],
      },
      body
    );
    expect(result.ok).toBe(false);
  });
});

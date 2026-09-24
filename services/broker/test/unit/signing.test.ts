import { describe, expect, it } from 'vitest';
import { privateKeyFromRaw, publicKeyFromRaw, verifySignature } from '../../src/signing.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';

describe('signing', () => {
  it('verifies a correctly signed request', () => {
    const keys = generateTestKeyPair();
    const body = Buffer.from(JSON.stringify({ slot: '0' }));
    const headers = signHeaders(keys, 'POST', '/reconcile', body, 1_000_000);
    expect(
      verifySignature(
        keys.publicKeyRaw,
        'POST',
        '/reconcile',
        headers['X-Broker-Timestamp'],
        headers['X-Broker-Nonce'],
        body,
        headers['X-Broker-Signature']
      )
    ).toBe(true);
  });

  it('refuses a signature verified against the wrong public key', () => {
    const signer = generateTestKeyPair();
    const otherKey = generateTestKeyPair();
    const body = Buffer.from('{}');
    const headers = signHeaders(signer, 'POST', '/reconcile', body, 1_000_000);
    expect(
      verifySignature(
        otherKey.publicKeyRaw,
        'POST',
        '/reconcile',
        headers['X-Broker-Timestamp'],
        headers['X-Broker-Nonce'],
        body,
        headers['X-Broker-Signature']
      )
    ).toBe(false);
  });

  it('refuses a signature whose body was tampered with after signing', () => {
    const keys = generateTestKeyPair();
    const body = Buffer.from('{"slot":"0"}');
    const headers = signHeaders(keys, 'POST', '/reconcile', body, 1_000_000);
    const tampered = Buffer.from('{"slot":"1"}');
    expect(
      verifySignature(
        keys.publicKeyRaw,
        'POST',
        '/reconcile',
        headers['X-Broker-Timestamp'],
        headers['X-Broker-Nonce'],
        tampered,
        headers['X-Broker-Signature']
      )
    ).toBe(false);
  });

  it('refuses a signature replayed against a different path', () => {
    const keys = generateTestKeyPair();
    const body = Buffer.from('{"slot":"0"}');
    const headers = signHeaders(keys, 'POST', '/reconcile', body, 1_000_000);
    expect(
      verifySignature(
        keys.publicKeyRaw,
        'POST',
        '/reset',
        headers['X-Broker-Timestamp'],
        headers['X-Broker-Nonce'],
        body,
        headers['X-Broker-Signature']
      )
    ).toBe(false);
  });

  it('publicKeyFromRaw and privateKeyFromRaw refuse a key of the wrong length', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow(/must be 32 raw bytes/);
    expect(() => privateKeyFromRaw(Buffer.alloc(33))).toThrow(/must be 32 raw bytes/);
  });

  it('verifySignature returns false, not a throw, when the public key is the wrong length', () => {
    const keys = generateTestKeyPair();
    const body = Buffer.from('{}');
    const headers = signHeaders(keys, 'GET', '/drain', body, 1_000_000);
    expect(
      verifySignature(
        Buffer.alloc(31),
        'GET',
        '/drain',
        headers['X-Broker-Timestamp'],
        headers['X-Broker-Nonce'],
        body,
        headers['X-Broker-Signature']
      )
    ).toBe(false);
  });

  it('refuses malformed base64 and a truncated signature without throwing', () => {
    const keys = generateTestKeyPair();
    const body = Buffer.from('{}');
    expect(
      verifySignature(
        keys.publicKeyRaw,
        'GET',
        '/drain',
        '1',
        'n'.repeat(16),
        body,
        '***not-base64***'
      )
    ).toBe(false);
    expect(
      verifySignature(keys.publicKeyRaw, 'GET', '/drain', '1', 'n'.repeat(16), body, 'YQ==')
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createInMemoryReplayGuard } from '../src/replay.js';
import { referenceSign } from './support/reference-signer.js';
import { IDENTITY, SIGNING_DATE } from './support/verifier-fixtures.js';
import { requestIdentity } from '../src/sigv4-verifier.js';

const WINDOW = 5 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 14, 9, 30, 15);
const sig = (n: number): string => n.toString(16).padStart(64, '0');

describe('the replay guard', () => {
  it('claims a signature once and calls its repeat a replay', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW });
    expect(guard.claim(sig(1), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(1), T0, T0)).toBe('replayed');
    expect(guard.claim(sig(1), T0, T0 + 4 * 60 * 1000)).toBe('replayed');
  });

  it('holds a signature for the whole window, however many differ in the same second', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW });
    for (let n = 0; n < 50; n += 1) expect(guard.claim(sig(n), T0, T0)).toBe('claimed');
    // One second before the window closes, every one is still spent.
    const late = T0 + WINDOW - 1000;
    for (let n = 0; n < 50; n += 1) expect(guard.claim(sig(n), T0, late)).toBe('replayed');
  });

  it('forgets a signature once its request could no longer pass the clock check', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW });
    expect(guard.claim(sig(1), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(1), T0, T0 + WINDOW + 2000)).toBe('claimed');
  });

  it('remembers a request dated ahead of the clock for as long as it is dated ahead', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW });
    // Signed five minutes in the future: still accepted for ten minutes from now.
    const ahead = T0 + WINDOW;
    expect(guard.claim(sig(1), ahead, T0)).toBe('claimed');
    expect(guard.claim(sig(1), ahead, T0 + 2 * WINDOW - 1000)).toBe('replayed');
  });

  it('refuses at its bound without evicting a live entry, and makes room as entries expire', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW, limit: 3 });
    for (let n = 1; n <= 3; n += 1) expect(guard.claim(sig(n), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(4), T0, T0)).toBe('full');
    // Nothing was evicted for the newcomer: the first is still spent.
    expect(guard.claim(sig(1), T0, T0)).toBe('replayed');
    expect(guard.claim(sig(4), T0, T0 + WINDOW + 2000)).toBe('claimed');
  });

  it('drops a whole second of expired entries at once, and only those', () => {
    const guard = createInMemoryReplayGuard({ windowMs: 10_000, limit: 4 });
    expect(guard.claim(sig(1), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(2), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(3), T0 + 5000, T0 + 5000)).toBe('claimed');
    expect(guard.claim(sig(4), T0 + 5000, T0 + 5000)).toBe('claimed');
    expect(guard.claim(sig(5), T0 + 5000, T0 + 5000)).toBe('full');
    // The first second has expired (T0 + 11 s), the later one has not.
    expect(guard.claim(sig(5), T0 + 11_000, T0 + 11_000)).toBe('claimed');
    expect(guard.claim(sig(6), T0 + 11_000, T0 + 11_000)).toBe('claimed');
    expect(guard.claim(sig(7), T0 + 11_000, T0 + 11_000)).toBe('full');
    expect(guard.claim(sig(3), T0 + 5000, T0 + 11_000)).toBe('replayed');
  });

  it('gives a claim back, once, and only the one released', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW, limit: 2 });
    expect(guard.claim(sig(1), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(2), T0, T0)).toBe('claimed');
    guard.release(sig(1));
    guard.release(sig(9));
    expect(guard.claim(sig(2), T0, T0)).toBe('replayed');
    expect(guard.claim(sig(1), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(1), T0, T0)).toBe('replayed');
  });

  it('refuses a window or bound that makes no sense', () => {
    expect(() => createInMemoryReplayGuard({ windowMs: -1 })).toThrow(RangeError);
    expect(() => createInMemoryReplayGuard({ windowMs: Number.NaN })).toThrow(RangeError);
    expect(() => createInMemoryReplayGuard({ windowMs: WINDOW, limit: 0 })).toThrow(RangeError);
  });

  it('stays small when full at its default bound', () => {
    const guard = createInMemoryReplayGuard({ windowMs: WINDOW });
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 50_000; n += 1) expect(guard.claim(sig(n), T0, T0)).toBe('claimed');
    expect(guard.claim(sig(50_000), T0, T0)).toBe('full');
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(40 * 1024 * 1024);
  });
});

describe('requestIdentity', () => {
  it('reads the signature and the signing time from a signed request', async () => {
    const { request, headers } = await referenceSign(
      {
        method: 'GET',
        path: '/media-shard-a/q7f3k2m9x1/photo.png',
        headers: { host: 'storage-gateway.internal:8443' },
      },
      IDENTITY
    );
    const identity = requestIdentity(request);
    expect(identity?.requestTimeMs).toBe(SIGNING_DATE.getTime());
    expect(identity?.signature).toBe(
      /Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? '')?.[1]
    );
  });

  it('reads nothing from a request that is not signed', () => {
    expect(requestIdentity({ method: 'GET', rawTarget: '/', headers: {} })).toBeUndefined();
    expect(
      requestIdentity({
        method: 'GET',
        rawTarget: '/',
        headers: { authorization: 'Basic abc', 'x-amz-date': '20261114T093015Z' },
      })
    ).toBeUndefined();
  });
});

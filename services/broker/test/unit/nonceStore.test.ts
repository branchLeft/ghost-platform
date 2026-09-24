import { describe, expect, it } from 'vitest';
import { createInMemoryNonceStore } from '../../src/nonceStore.js';

describe('createInMemoryNonceStore', () => {
  it('claims a fresh nonce and refuses the same nonce again', () => {
    const store = createInMemoryNonceStore(60_000);
    expect(store.claim('abc', 0)).toBe(true);
    expect(store.claim('abc', 1)).toBe(false);
  });

  it('lets a nonce be reused once its window has fully elapsed', () => {
    const store = createInMemoryNonceStore(1000);
    expect(store.claim('abc', 0)).toBe(true);
    expect(store.claim('abc', 999)).toBe(false);
    expect(store.claim('abc', 1000)).toBe(true);
  });

  it('tracks distinct nonces independently', () => {
    const store = createInMemoryNonceStore(60_000);
    expect(store.claim('a', 0)).toBe(true);
    expect(store.claim('b', 0)).toBe(true);
    expect(store.claim('a', 0)).toBe(false);
    expect(store.claim('b', 0)).toBe(false);
  });

  it('fails closed once the store is full, rather than evicting a live entry', () => {
    const store = createInMemoryNonceStore(60_000, 2);
    expect(store.claim('a', 0)).toBe(true);
    expect(store.claim('b', 0)).toBe(true);
    expect(store.claim('c', 0)).toBe(false);
    // The two live entries are still both live, not silently evicted to
    // make room for the refused third.
    expect(store.claim('a', 0)).toBe(false);
    expect(store.claim('b', 0)).toBe(false);
  });

  it('recovers headroom once earlier entries expire, without a full sweep every call', () => {
    const store = createInMemoryNonceStore(1000, 2);
    expect(store.claim('a', 0)).toBe(true);
    expect(store.claim('b', 0)).toBe(true);
    expect(store.claim('c', 500)).toBe(false); // still full, neither has expired yet
    expect(store.claim('c', 1000)).toBe(true); // both expired by now -- swept from the front
  });
});

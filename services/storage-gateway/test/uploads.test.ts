import { describe, expect, it } from 'vitest';
import { createInMemoryUploadBindings } from '../src/uploads.js';

const A = { keyId: 'key-a', bucket: 'shard', key: 'folder-a/x.png' };

describe('in-memory upload bindings', () => {
  it('matches only the exact tenant, bucket and object key it was bound to', () => {
    const uploads = createInMemoryUploadBindings();
    expect(uploads.bind('u1', A)).toBe(true);
    expect(uploads.isBound('u1', A)).toBe(true);
    expect(uploads.isBound('u1', { ...A, keyId: 'key-b' })).toBe(false);
    expect(uploads.isBound('u1', { ...A, bucket: 'other' })).toBe(false);
    expect(uploads.isBound('u1', { ...A, key: 'folder-a/y.png' })).toBe(false);
    expect(uploads.isBound('unknown', A)).toBe(false);
  });

  it('forgets a released upload', () => {
    const uploads = createInMemoryUploadBindings();
    uploads.bind('u1', A);
    uploads.release('u1');
    expect(uploads.isBound('u1', A)).toBe(false);
  });

  it('expires a binding after its lifetime', () => {
    let now = 1000;
    const uploads = createInMemoryUploadBindings({ ttlMs: 50, nowMs: () => now });
    uploads.bind('u1', A);
    now = 1049;
    expect(uploads.isBound('u1', A)).toBe(true);
    now = 1050;
    expect(uploads.isBound('u1', A)).toBe(false);
  });

  it('refuses a new binding when full of live ones, and reuses room freed by expiry', () => {
    let now = 0;
    const uploads = createInMemoryUploadBindings({ limit: 2, ttlMs: 100, nowMs: () => now });
    expect(uploads.bind('u1', A)).toBe(true);
    now = 60;
    expect(uploads.bind('u2', A)).toBe(true);
    expect(uploads.bind('u3', A)).toBe(false);
    expect(uploads.isBound('u1', A)).toBe(true);
    now = 110;
    expect(uploads.bind('u3', A)).toBe(true);
    expect(uploads.isBound('u1', A)).toBe(false);
    expect(uploads.isBound('u2', A)).toBe(true);
  });
});

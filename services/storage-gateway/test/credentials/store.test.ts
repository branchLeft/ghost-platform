import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCredentialStore } from '../../src/credentials/store.js';

const KEY = 'GWAAAAAAAAAAAAAAAAAAAAAAAA';
const NEW = {
  keyId: KEY,
  folder: 'f0f0f0f0f0f0f0f0f0f0',
  bucket: 'shard-one',
  createdAt: '2026-10-06T00:00:00.000Z',
};

describe('SqliteCredentialStore', () => {
  let dir: string;
  let path: string;
  let store: SqliteCredentialStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-store-'));
    path = join(dir, 'credentials.sqlite');
    store = SqliteCredentialStore.open(path);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a new credential as active and reads it back', async () => {
    const inserted = store.insert(NEW);
    expect(inserted).toEqual({ ok: true, credential: { ...NEW, state: 'active' } });
    await expect(store.lookup(KEY)).resolves.toEqual({ ...NEW, state: 'active' });
  });

  it('resolves an unissued key id to undefined', async () => {
    await expect(store.lookup('GWNEVERISSUED00000000')).resolves.toBeUndefined();
    expect(store.get('GWNEVERISSUED00000000')).toBeUndefined();
  });

  it('never reissues a key id that is active', () => {
    store.insert(NEW);
    expect(store.insert({ ...NEW, folder: 'otherfolder000000000', bucket: 'shard-two' })).toEqual({
      ok: false,
      reason: 'key-id-taken',
    });
    expect(store.get(KEY)).toEqual({ ...NEW, state: 'active' });
  });

  it('never reissues a key id that was disabled, and does not revive it', () => {
    store.insert(NEW);
    expect(store.disable(KEY)).toBe('disabled');
    expect(store.insert({ ...NEW, createdAt: '2026-10-07T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'key-id-taken',
    });
    expect(store.get(KEY)?.state).toBe('disabled');
    expect(store.get(KEY)?.createdAt).toBe(NEW.createdAt);
  });

  it('disables an active credential, and the lookup the router reads then says so', async () => {
    store.insert(NEW);
    expect(store.disable(KEY)).toBe('disabled');
    await expect(store.lookup(KEY)).resolves.toMatchObject({ state: 'disabled' });
  });

  it('reports a second disable as not active, and an unknown key as unknown', () => {
    store.insert(NEW);
    store.disable(KEY);
    expect(store.disable(KEY)).toBe('not-active');
    expect(store.disable('GWNEVERISSUED00000000')).toBe('unknown');
  });

  it('keeps every credential across a close and reopen', () => {
    store.insert(NEW);
    store.disable(KEY);
    store.close();
    store = SqliteCredentialStore.open(path);
    expect(store.get(KEY)).toEqual({ ...NEW, state: 'disabled' });
    expect(store.insert(NEW)).toEqual({ ok: false, reason: 'key-id-taken' });
  });

  it('closes the database and rethrows when the migrations cannot be read', () => {
    expect(() =>
      SqliteCredentialStore.open(join(dir, 'other.sqlite'), join(dir, 'missing'))
    ).toThrow();
  });
});

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCredentialStore, StoreRollbackError } from '../../src/credentials/store.js';

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

  it('refuses a second active credential for a folder, and allows one once the first is disabled', () => {
    store.insert(NEW);
    const other = { ...NEW, keyId: 'GWBBBBBBBBBBBBBBBBBBBBBBBB' };
    expect(store.insert(other)).toEqual({ ok: false, reason: 'folder-has-active-credential' });
    expect(store.get(other.keyId)).toBeUndefined();
    expect(store.disableFolder(NEW.folder)).toBe(1);
    expect(store.insert(other)).toMatchObject({ ok: true });
    expect(store.listByFolder(NEW.folder).map((c) => [c.keyId, c.state])).toEqual([
      [KEY, 'disabled'],
      [other.keyId, 'active'],
    ]);
  });

  it('lists nothing and disables nothing for an unused folder', () => {
    expect(store.listByFolder('unusedfolder00000001')).toEqual([]);
    expect(store.disableFolder('unusedfolder00000001')).toBe(0);
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

  describe('rollback guard', () => {
    const OTHER = { ...NEW, keyId: 'GWBBBBBBBBBBBBBBBBBBBBBBBB', folder: 'f1f1f1f1f1f1f1f1f1f1' };

    function restoreOlderCopy(backup: string): void {
      store.close();
      copyFileSync(backup, path);
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }

    function backUp(): string {
      store.close();
      const backup = join(dir, 'backup.sqlite');
      copyFileSync(path, backup);
      store = SqliteCredentialStore.open(path);
      return backup;
    }

    it('refuses to open a database restored from before a credential was disabled', () => {
      store.insert(NEW);
      const backup = backUp();
      expect(store.disable(KEY)).toBe('disabled');
      restoreOlderCopy(backup);
      expect(() => SqliteCredentialStore.open(path)).toThrow(StoreRollbackError);
    });

    it('refuses a restore that predates a new mint, folder disable or insert', () => {
      const backup = backUp();
      store.insert(NEW);
      store.insert(OTHER);
      expect(store.disableFolder(NEW.folder)).toBe(1);
      restoreOlderCopy(backup);
      expect(() => SqliteCredentialStore.open(path)).toThrow(/restored from an older copy/);
    });

    it('opens normally after ordinary restarts, and counts only real changes', () => {
      store.insert(NEW);
      store.disable(KEY);
      store.disable(KEY);
      store.disableFolder('nothing-here-at-all');
      store.insert(NEW);
      store.close();
      store = SqliteCredentialStore.open(path);
      expect(store.get(KEY)?.state).toBe('disabled');
      expect(readGeneration()).toBe(2);
    });

    it('catches a stale anchor up to the database and never moves it back', () => {
      store.insert(NEW);
      store.close();
      writeFileSync(`${path}.generation`, '0\n');
      store = SqliteCredentialStore.open(path);
      expect(readGeneration()).toBe(1);
    });

    it('treats a damaged anchor as an error rather than as no anchor', () => {
      store.close();
      writeFileSync(`${path}.generation`, 'garbage');
      expect(() => SqliteCredentialStore.open(path)).toThrow(/damaged/);
    });

    it('can keep the anchor elsewhere, and has none for an in-memory store', () => {
      const memory = SqliteCredentialStore.open(':memory:');
      expect(memory.insert(NEW).ok).toBe(true);
      memory.close();
      const anchor = join(dir, 'elsewhere.anchor');
      const second = SqliteCredentialStore.open(join(dir, 'second.sqlite'), undefined, anchor);
      second.insert(NEW);
      second.close();
      expect(readFileSync(anchor, 'utf8')).toBe('1\n');
    });

    function readGeneration(): number {
      return Number(readFileSync(`${path}.generation`, 'utf8'));
    }
  });
});

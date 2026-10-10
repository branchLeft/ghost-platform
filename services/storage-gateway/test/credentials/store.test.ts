import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqliteCredentialStore,
  StoreAnchorMissingError,
  StoreRollbackError,
} from '../../src/credentials/store.js';

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
      // The first open stamps generation 1; the insert and the disable are 2 and 3.
      expect(readGeneration()).toBe(3);
    });

    it('catches a stale anchor up to the database and never moves it back', () => {
      store.insert(NEW);
      store.close();
      // The state a crash between the commit and the anchor write leaves.
      writeFileSync(`${path}.generation`, '1\n');
      store = SqliteCredentialStore.open(path);
      expect(readGeneration()).toBe(2);
      expect(store.get(KEY)?.state).toBe('active');
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
      expect(readFileSync(anchor, 'utf8')).toBe('2\n');
    });

    function readGeneration(): number {
      return Number(readFileSync(`${path}.generation`, 'utf8'));
    }

    describe('a missing anchor', () => {
      const anchor = (): string => `${path}.generation`;

      function failOpen(): StoreAnchorMissingError {
        try {
          SqliteCredentialStore.open(path).close();
        } catch (err) {
          expect(err).toBeInstanceOf(StoreAnchorMissingError);
          return err as StoreAnchorMissingError;
        }
        return expect.unreachable('open did not refuse');
      }

      it('refuses an older copy restored with the anchor deleted, and does not recreate the anchor', () => {
        store.insert(NEW);
        const backup = backUp();
        expect(store.disable(KEY)).toBe('disabled');
        restoreOlderCopy(backup);
        rmSync(anchor());
        const refused = failOpen();
        expect(refused).toBeInstanceOf(StoreRollbackError);
        expect(refused.found).toBe(2);
        expect(existsSync(anchor())).toBe(false);
      });

      it('refuses a copy taken before any change once the anchor is gone', () => {
        const backup = backUp();
        store.insert(NEW);
        store.disable(KEY);
        restoreOlderCopy(backup);
        rmSync(anchor());
        expect(failOpen().found).toBe(1);
        expect(existsSync(anchor())).toBe(false);
      });

      it('refuses a database that is ahead of a deleted anchor, even with no restore', () => {
        store.insert(NEW);
        store.close();
        rmSync(anchor());
        expect(failOpen().found).toBe(2);
      });

      it('names the anchor, the generation and the loss in its message', () => {
        store.insert(NEW);
        store.close();
        rmSync(anchor());
        const { message } = failOpen();
        expect(message).toContain(`anchor file ${anchor()} is missing`);
        expect(message).toContain('generation 2');
        expect(message).toContain('write 2 and a newline');
        expect(message).toContain('undone');
      });

      it('opens once the operator writes the database generation to the anchor', () => {
        store.insert(NEW);
        const backup = backUp();
        store.disable(KEY);
        restoreOlderCopy(backup);
        rmSync(anchor());
        const refused = failOpen();
        writeFileSync(anchor(), `${refused.found}\n`);
        store = SqliteCredentialStore.open(path);
        // The restored copy is now the record: the disable made after it is undone.
        expect(store.get(KEY)?.state).toBe('active');
        expect(readGeneration()).toBe(refused.found);
      });

      it('opens a first run, and makes the anchor before any change can be made', () => {
        expect(readFileSync(anchor(), 'utf8')).toBe('1\n');
        const second = SqliteCredentialStore.open(join(dir, 'fresh.sqlite'));
        second.close();
        expect(readFileSync(join(dir, 'fresh.sqlite.generation'), 'utf8')).toBe('1\n');
      });

      it('survives a crash right after the first generation is stamped', () => {
        const crashed = join(dir, 'crashed.sqlite');
        const original = Database.prototype.pragma;
        const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
          this: Database.Database,
          source: string,
          options?: Database.PragmaOptions
        ) {
          const result = original.call(this, source, options);
          if (source === 'user_version = 1') throw new Error('simulated crash');
          return result;
        });
        try {
          expect(() => SqliteCredentialStore.open(crashed)).toThrow('simulated crash');
        } finally {
          spy.mockRestore();
        }
        const reopened = SqliteCredentialStore.open(crashed);
        expect(reopened.insert(NEW).ok).toBe(true);
        reopened.close();
        expect(readFileSync(`${crashed}.generation`, 'utf8')).toBe('2\n');
      });

      it('opens an upgrade: rows present, no generation set, no anchor', () => {
        store.insert(NEW);
        store.close();
        const raw = new Database(path);
        raw.pragma('user_version = 0');
        raw.close();
        rmSync(anchor());
        store = SqliteCredentialStore.open(path);
        expect(store.get(KEY)).toEqual({ ...NEW, state: 'active' });
        expect(readGeneration()).toBe(1);
      });

      it('treats an anchor it cannot read as an error, never as a missing one', () => {
        store.close();
        rmSync(anchor());
        mkdirSync(anchor());
        expect(() => SqliteCredentialStore.open(path)).toThrow(/EISDIR/);
      });

      it('leaves the database file untouched when it refuses', () => {
        store.insert(NEW);
        store.close();
        rmSync(anchor());
        const before = readFileSync(path);
        failOpen();
        expect(readFileSync(path).equals(before)).toBe(true);
      });
    });

    it('commits a change and its generation together', () => {
      store.insert(NEW);
      const original = Database.prototype.pragma;
      const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
        this: Database.Database,
        source: string,
        options?: Database.PragmaOptions
      ) {
        if (source.startsWith('user_version =')) throw new Error('simulated write failure');
        return original.call(this, source, options);
      });
      try {
        expect(() => store.disable(KEY)).toThrow('simulated write failure');
        expect(() => store.disableFolder(NEW.folder)).toThrow('simulated write failure');
        expect(() => store.insert(OTHER)).toThrow('simulated write failure');
      } finally {
        spy.mockRestore();
      }
      expect(store.get(KEY)?.state).toBe('active');
      expect(store.get(OTHER.keyId)).toBeUndefined();
      expect(readGeneration()).toBe(2);
    });
  });
});

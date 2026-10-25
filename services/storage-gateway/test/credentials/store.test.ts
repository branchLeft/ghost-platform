import {
  copyFileSync,
  cpSync,
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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIGRATIONS_FOLDER,
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
const DISABLED_AT = '2026-10-08T00:00:00.000Z';

// The credentials table at the 0001 shape, before disabled_at existed.
const legacyCredentials = sqliteTable('credentials', {
  keyId: text('key_id').primaryKey(),
  folder: text('folder').notNull(),
  bucket: text('bucket').notNull(),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
});

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
    expect(inserted).toEqual({
      ok: true,
      credential: { ...NEW, state: 'active', disabledAt: null },
    });
    await expect(store.lookup(KEY)).resolves.toEqual({
      ...NEW,
      state: 'active',
      disabledAt: null,
    });
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
    expect(store.get(KEY)).toEqual({ ...NEW, state: 'active', disabledAt: null });
  });

  it('never reissues a key id that was disabled, and does not revive it', () => {
    store.insert(NEW);
    expect(store.disable(KEY, DISABLED_AT)).toBe('disabled');
    expect(store.insert({ ...NEW, createdAt: '2026-10-07T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'key-id-taken',
    });
    expect(store.get(KEY)?.state).toBe('disabled');
    expect(store.get(KEY)?.createdAt).toBe(NEW.createdAt);
  });

  it('disables an active credential, and the lookup the router reads then says so', async () => {
    store.insert(NEW);
    expect(store.disable(KEY, DISABLED_AT)).toBe('disabled');
    await expect(store.lookup(KEY)).resolves.toMatchObject({ state: 'disabled' });
  });

  it('reports a second disable as not active, and an unknown key as unknown', () => {
    store.insert(NEW);
    store.disable(KEY, DISABLED_AT);
    expect(store.disable(KEY, DISABLED_AT)).toBe('not-active');
    expect(store.disable('GWNEVERISSUED00000000', DISABLED_AT)).toBe('unknown');
  });

  it('a newly minted credential has disabled_at null', () => {
    store.insert(NEW);
    expect(store.get(KEY)?.disabledAt).toBeNull();
    const other = { ...NEW, keyId: 'GWBBBBBBBBBBBBBBBBBBBBBBBB', folder: 'f1f1f1f1f1f1f1f1f1f1' };
    store.insert(other);
    store.disable(KEY, DISABLED_AT);
    expect(store.get(other.keyId)?.disabledAt).toBeNull();
  });

  it('disable records disabled_at for the key moved to disabled', () => {
    store.insert(NEW);
    expect(store.disable(KEY, DISABLED_AT)).toBe('disabled');
    expect(store.get(KEY)).toEqual({ ...NEW, state: 'disabled', disabledAt: DISABLED_AT });
  });

  it('a repeated disable leaves the first disabled_at unchanged', () => {
    store.insert(NEW);
    store.disable(KEY, DISABLED_AT);
    expect(store.disable(KEY, '2026-10-09T00:00:00.000Z')).toBe('not-active');
    expect(store.get(KEY)?.disabledAt).toBe(DISABLED_AT);
  });

  it("disableFolder stamps every credential it disables and leaves an earlier-disabled credential's disabled_at as it was", () => {
    const EARLIER = '2026-10-07T00:00:00.000Z';
    const later = { ...NEW, keyId: 'GWBBBBBBBBBBBBBBBBBBBBBBBB' };
    const elsewhere = {
      ...NEW,
      keyId: 'GWCCCCCCCCCCCCCCCCCCCCCCCC',
      folder: 'f1f1f1f1f1f1f1f1f1f1',
    };
    store.insert(NEW);
    store.disable(KEY, EARLIER);
    store.insert(later);
    store.insert(elsewhere);
    expect(store.disableFolder(NEW.folder, DISABLED_AT)).toBe(1);
    expect(store.get(KEY)?.disabledAt).toBe(EARLIER);
    expect(store.get(later.keyId)).toEqual({
      ...later,
      state: 'disabled',
      disabledAt: DISABLED_AT,
    });
    expect(store.get(elsewhere.keyId)).toEqual({ ...elsewhere, state: 'active', disabledAt: null });
    expect(store.disableFolder(NEW.folder, '2026-10-09T00:00:00.000Z')).toBe(0);
    expect(store.get(later.keyId)?.disabledAt).toBe(DISABLED_AT);
  });

  it('refuses a second active credential for a folder, and allows one once the first is disabled', () => {
    store.insert(NEW);
    const other = { ...NEW, keyId: 'GWBBBBBBBBBBBBBBBBBBBBBBBB' };
    expect(store.insert(other)).toEqual({ ok: false, reason: 'folder-has-active-credential' });
    expect(store.get(other.keyId)).toBeUndefined();
    expect(store.disableFolder(NEW.folder, DISABLED_AT)).toBe(1);
    expect(store.insert(other)).toMatchObject({ ok: true });
    expect(store.listByFolder(NEW.folder).map((c) => [c.keyId, c.state])).toEqual([
      [KEY, 'disabled'],
      [other.keyId, 'active'],
    ]);
  });

  it('lists nothing and disables nothing for an unused folder', () => {
    expect(store.listByFolder('unusedfolder00000001')).toEqual([]);
    expect(store.disableFolder('unusedfolder00000001', DISABLED_AT)).toBe(0);
  });

  it('keeps every credential across a close and reopen', () => {
    store.insert(NEW);
    store.disable(KEY, DISABLED_AT);
    store.close();
    store = SqliteCredentialStore.open(path);
    expect(store.get(KEY)).toEqual({ ...NEW, state: 'disabled', disabledAt: DISABLED_AT });
    expect(store.insert(NEW)).toEqual({ ok: false, reason: 'key-id-taken' });
  });

  it('closes the database and rethrows when the migrations cannot be read', () => {
    expect(() =>
      SqliteCredentialStore.open(join(dir, 'other.sqlite'), join(dir, 'missing'))
    ).toThrow();
  });

  it('a database at the 0001 schema keeps its rows when opened with the new migration', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'gw-legacy-'));
    try {
      const copiedFolder = join(legacyDir, 'drizzle');
      cpSync(MIGRATIONS_FOLDER, copiedFolder, { recursive: true });
      const journalPath = join(copiedFolder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 1);
      writeFileSync(journalPath, JSON.stringify(journal));

      const legacyPath = join(legacyDir, 'legacy.sqlite');
      // The store's own insert names every column of the current schema, so a
      // row at the 0001 shape is written through a table that declares only
      // the 0001 columns.
      SqliteCredentialStore.open(legacyPath, copiedFolder).close();
      const raw = new Database(legacyPath);
      const columns = raw.pragma('table_info(credentials)') as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain('disabled_at');
      const legacyDb = drizzle(raw);
      legacyDb
        .insert(legacyCredentials)
        .values({
          keyId: NEW.keyId,
          folder: NEW.folder,
          bucket: NEW.bucket,
          state: 'active',
          createdAt: NEW.createdAt,
        })
        .run();
      legacyDb
        .update(legacyCredentials)
        .set({ state: 'disabled' })
        .where(eq(legacyCredentials.keyId, KEY))
        .run();
      raw.close();

      const upgraded = SqliteCredentialStore.open(legacyPath, MIGRATIONS_FOLDER);
      try {
        expect(upgraded.get(KEY)).toEqual({ ...NEW, state: 'disabled', disabledAt: null });
        expect(upgraded.listByFolder(NEW.folder)).toHaveLength(1);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
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
      expect(store.disable(KEY, DISABLED_AT)).toBe('disabled');
      restoreOlderCopy(backup);
      expect(() => SqliteCredentialStore.open(path)).toThrow(StoreRollbackError);
    });

    it('refuses a restore that predates a new mint, folder disable or insert', () => {
      const backup = backUp();
      store.insert(NEW);
      store.insert(OTHER);
      expect(store.disableFolder(NEW.folder, DISABLED_AT)).toBe(1);
      restoreOlderCopy(backup);
      expect(() => SqliteCredentialStore.open(path)).toThrow(/restored from an older copy/);
    });

    it('opens normally after ordinary restarts, and counts only real changes', () => {
      store.insert(NEW);
      store.disable(KEY, DISABLED_AT);
      store.disable(KEY, DISABLED_AT);
      store.disableFolder('nothing-here-at-all', DISABLED_AT);
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
        expect(store.disable(KEY, DISABLED_AT)).toBe('disabled');
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
        store.disable(KEY, DISABLED_AT);
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
        store.disable(KEY, DISABLED_AT);
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
        expect(store.get(KEY)).toEqual({ ...NEW, state: 'active', disabledAt: null });
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
        expect(() => store.disable(KEY, DISABLED_AT)).toThrow('simulated write failure');
        expect(() => store.disableFolder(NEW.folder, DISABLED_AT)).toThrow(
          'simulated write failure'
        );
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

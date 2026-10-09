import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { CredentialRecord, CredentialStore } from '../contracts.js';
import { credentials } from './schema.js';

/** Where drizzle-kit writes the migrations: `../../drizzle` from both `src/credentials/` and `dist/credentials/`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** A stored credential: the record the router reads, plus its key id. */
export interface StoredCredential extends CredentialRecord {
  readonly keyId: string;
}

export interface NewCredential {
  readonly keyId: string;
  readonly folder: string;
  readonly bucket: string;
  readonly createdAt: string;
}

export type InsertResult =
  | { readonly ok: true; readonly credential: StoredCredential }
  /** The key id was minted before, in any state. It is never issued again. */
  | { readonly ok: false; readonly reason: 'key-id-taken' }
  /** The folder already has an active credential; disable it first. */
  | { readonly ok: false; readonly reason: 'folder-has-active-credential' };

export type DisableResult = 'disabled' | 'not-active' | 'unknown';

/** Thrown at open when the database file is older than the last write this host recorded. */
export class StoreRollbackError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number
  ) {
    super(
      `the credential store is at generation ${found} but this host last wrote ${expected}: ` +
        'it was restored from an older copy; refusing to start'
    );
    this.name = 'StoreRollbackError';
  }
}

/** Reads a generation anchor; a missing file is generation 0, a damaged one is an error. */
function readAnchor(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 0;
    throw err;
  }
  if (!/^[0-9]{1,15}\n?$/.test(text)) throw new Error('the generation anchor is damaged');
  return Number(text.trim());
}

/** Replaces the anchor atomically and flushes it, so it never reads back short or older. */
function writeAnchor(path: string, generation: number): void {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, `${generation}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * The credential store, in one SQLite file through Drizzle. Holds no secret:
 * a secret is derived from the master secret and key id on demand. Writes
 * commit with `synchronous = FULL`. There is no delete: a key id, once
 * minted, is taken for good.
 *
 * Rollback guard: each change bumps `user_version`, then an anchor file
 * beside the database. Opening a database below the anchor refuses to start.
 * Keep the anchor off the restored volume and out of the backup job.
 */
export class SqliteCredentialStore implements CredentialStore {
  readonly #client: Database.Database;
  readonly #db: BetterSQLite3Database;

  readonly #anchorPath: string | undefined;

  private constructor(client: Database.Database, anchorPath: string | undefined) {
    this.#client = client;
    this.#db = drizzle(client);
    this.#anchorPath = anchorPath;
  }

  /** Opens (creating if absent) the store at `path` and brings its schema up to date. */
  static open(
    path: string,
    migrationsFolder: string = MIGRATIONS_FOLDER,
    anchorPath: string | undefined = path === ':memory:' ? undefined : `${path}.generation`
  ): SqliteCredentialStore {
    const client = new Database(path);
    try {
      client.pragma('journal_mode = WAL');
      client.pragma('synchronous = FULL');
      migrate(drizzle(client), { migrationsFolder });
      if (anchorPath !== undefined) {
        const found = client.pragma('user_version', { simple: true }) as number;
        const expected = readAnchor(anchorPath);
        if (found < expected) throw new StoreRollbackError(found, expected);
        // A database ahead of its anchor (a crash between the two writes,
        // or a first run) catches the anchor up; it never moves it back.
        if (found > expected) writeAnchor(anchorPath, found);
      }
    } catch (err) {
      client.close();
      throw err;
    }
    return new SqliteCredentialStore(client, anchorPath);
  }

  /** Moves the generation forward after a change, in the database and then the anchor. */
  #advance(): void {
    const next = (this.#client.pragma('user_version', { simple: true }) as number) + 1;
    this.#client.pragma(`user_version = ${next}`);
    if (this.#anchorPath !== undefined) writeAnchor(this.#anchorPath, next);
  }

  lookup(keyId: string): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.get(keyId));
  }

  get(keyId: string): StoredCredential | undefined {
    const row = this.#db.select().from(credentials).where(eq(credentials.keyId, keyId)).get();
    return row === undefined ? undefined : { ...row };
  }

  /**
   * Records a new credential. Refuses, rather than overwrites, a key id that
   * has ever been minted, whatever its state, and refuses a folder that
   * already has an active credential.
   */
  insert(credential: NewCredential): InsertResult {
    const inserted = this.#db
      .insert(credentials)
      .values({ ...credential, state: 'active' })
      .onConflictDoNothing()
      .returning()
      .all();
    const row = inserted[0];
    if (row !== undefined) {
      this.#advance();
      return { ok: true, credential: { ...row } };
    }
    if (this.get(credential.keyId) !== undefined) return { ok: false, reason: 'key-id-taken' };
    return { ok: false, reason: 'folder-has-active-credential' };
  }

  /** Every credential ever minted for a folder, oldest first. */
  listByFolder(folder: string): StoredCredential[] {
    return this.#db
      .select()
      .from(credentials)
      .where(eq(credentials.folder, folder))
      .orderBy(asc(credentials.createdAt), asc(credentials.keyId))
      .all()
      .map((row) => ({ ...row }));
  }

  /** Disables every active credential for a folder; returns how many it changed. */
  disableFolder(folder: string): number {
    const changed = this.#db
      .update(credentials)
      .set({ state: 'disabled' })
      .where(and(eq(credentials.folder, folder), eq(credentials.state, 'active')))
      .returning({ keyId: credentials.keyId })
      .all().length;
    if (changed > 0) this.#advance();
    return changed;
  }

  /** Moves an active credential to disabled. A credential not active is left as it is. */
  disable(keyId: string): DisableResult {
    const updated = this.#db
      .update(credentials)
      .set({ state: 'disabled' })
      .where(and(eq(credentials.keyId, keyId), eq(credentials.state, 'active')))
      .returning({ keyId: credentials.keyId })
      .all();
    if (updated.length === 1) {
      this.#advance();
      return 'disabled';
    }
    return this.get(keyId) === undefined ? 'unknown' : 'not-active';
  }

  close(): void {
    this.#client.close();
  }
}

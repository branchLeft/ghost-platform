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

/**
 * Thrown at open when the database file is older than the last write this host
 * recorded. `expected` is undefined when the anchor itself is gone.
 */
export class StoreRollbackError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number | undefined,
    message?: string
  ) {
    super(
      message ??
        `the credential store is at generation ${found} but this host last wrote ${expected}: ` +
          'it was restored from an older copy; refusing to start'
    );
    this.name = 'StoreRollbackError';
  }
}

/**
 * Thrown at open when the database has recorded changes but its anchor file is
 * missing. The store cannot tell a lost anchor from an older copy restored
 * with its anchor deleted, so it starts only after an operator has chosen.
 */
export class StoreAnchorMissingError extends StoreRollbackError {
  constructor(
    found: number,
    readonly anchorPath: string
  ) {
    super(
      found,
      undefined,
      `the credential store is at generation ${found} but its anchor file ${anchorPath} is ` +
        'missing: refusing to start. Either the anchor was lost (an unmounted volume, a rebuilt ' +
        'host) or an older copy of the database was restored and the anchor deleted; the store ' +
        'cannot tell which, and never recreates the anchor itself. To recover, with the gateway ' +
        `stopped: (1) look for the anchor where it should live and mount that volume; (2) if it ` +
        'is gone, confirm this database file is the newest copy this host wrote, not one ' +
        `restored from a backup; (3) write ${found} and a newline, nothing else, to ${anchorPath} ` +
        'with mode 0600; (4) start the gateway, then compare every credential with your change ' +
        'record and disable again any that was disabled after this copy was taken. Writing the ' +
        'anchor accepts this copy as current: if it is older than the last write, every disable ' +
        'and mint since is undone until step 4 is done.'
    );
    this.name = 'StoreAnchorMissingError';
  }
}

/** Reads a generation anchor: undefined when the file is absent, an error when it is damaged. */
function readAnchor(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return undefined;
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
 * Refuses a database that is older than its anchor, or that has recorded
 * changes with no anchor at all. A database with no generation and no anchor
 * is a first run or an upgrade: it gets an anchor at 0 before it is used, so
 * from then on a missing anchor can only mean it was lost or deleted.
 */
function checkAnchor(client: Database.Database, anchorPath: string): void {
  const found = client.pragma('user_version', { simple: true }) as number;
  const expected = readAnchor(anchorPath);
  if (expected === undefined) {
    if (found > 0) throw new StoreAnchorMissingError(found, anchorPath);
    writeAnchor(anchorPath, 0);
    return;
  }
  if (found < expected) throw new StoreRollbackError(found, expected);
}

/**
 * Brings the anchor level with the database, never back. A database at
 * generation 0 is stamped 1 first, so a copy taken after this host first
 * opened it cannot be mistaken for a first run once its anchor is gone.
 */
function syncAnchor(client: Database.Database, anchorPath: string): void {
  let found = client.pragma('user_version', { simple: true }) as number;
  if (found === 0) {
    found = 1;
    client.pragma(`user_version = ${found}`);
  }
  if (readAnchor(anchorPath) !== found) writeAnchor(anchorPath, found);
}

/**
 * The credential store, in one SQLite file through Drizzle. Holds no secret:
 * secrets derive from the master secret and key id on demand. Writes commit
 * with `synchronous = FULL`. There is no delete: a key id is taken for good.
 *
 * Rollback guard: a change and its `user_version` bump commit together, then
 * the anchor file. Open refuses a database below its anchor, or with changes
 * and no anchor. Keep the anchor on another volume, out of the backup job:
 * the default beside the database returns with a directory-level restore.
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
      // Checked before the file is switched to WAL or migrated, so a refused
      // copy is left as it was found.
      if (anchorPath !== undefined) checkAnchor(client, anchorPath);
      client.pragma('journal_mode = WAL');
      client.pragma('synchronous = FULL');
      migrate(drizzle(client), { migrationsFolder });
      if (anchorPath !== undefined) syncAnchor(client, anchorPath);
    } catch (err) {
      client.close();
      throw err;
    }
    return new SqliteCredentialStore(client, anchorPath);
  }

  /**
   * Runs a change, and when it reports one moves the generation in the same
   * transaction, then the anchor. A crash between the commit and the anchor
   * write leaves the database ahead, which the next open catches up.
   */
  #record<T>(change: () => { readonly value: T; readonly changed: boolean }): T {
    let next: number | undefined;
    const value = this.#client.transaction(() => {
      const outcome = change();
      if (outcome.changed) {
        next = (this.#client.pragma('user_version', { simple: true }) as number) + 1;
        this.#client.pragma(`user_version = ${next}`);
      }
      return outcome.value;
    })();
    if (next !== undefined && this.#anchorPath !== undefined) writeAnchor(this.#anchorPath, next);
    return value;
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
    const row = this.#record(() => {
      const [inserted] = this.#db
        .insert(credentials)
        .values({ ...credential, state: 'active' })
        .onConflictDoNothing()
        .returning()
        .all();
      return { value: inserted, changed: inserted !== undefined };
    });
    if (row !== undefined) return { ok: true, credential: { ...row } };
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
    return this.#record(() => {
      const changed = this.#db
        .update(credentials)
        .set({ state: 'disabled' })
        .where(and(eq(credentials.folder, folder), eq(credentials.state, 'active')))
        .returning({ keyId: credentials.keyId })
        .all().length;
      return { value: changed, changed: changed > 0 };
    });
  }

  /** Moves an active credential to disabled. A credential not active is left as it is. */
  disable(keyId: string): DisableResult {
    const updated = this.#record(() => {
      const rows = this.#db
        .update(credentials)
        .set({ state: 'disabled' })
        .where(and(eq(credentials.keyId, keyId), eq(credentials.state, 'active')))
        .returning({ keyId: credentials.keyId })
        .all();
      return { value: rows.length, changed: rows.length === 1 };
    });
    if (updated === 1) return 'disabled';
    return this.get(keyId) === undefined ? 'unknown' : 'not-active';
  }

  close(): void {
    this.#client.close();
  }
}

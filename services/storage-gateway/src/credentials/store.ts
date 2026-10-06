import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
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
  | { readonly ok: false; readonly reason: 'key-id-taken' };

export type DisableResult = 'disabled' | 'not-active' | 'unknown';

/**
 * The credential store, in one SQLite file through Drizzle. Holds no secret:
 * a tenant's secret is derived from the master secret and the key id on
 * demand. Writes are synchronous and committed with `synchronous = FULL`,
 * so a credential whose secret was handed out survives a power cut.
 * There is no delete: a key id, once minted, is taken for good.
 */
export class SqliteCredentialStore implements CredentialStore {
  readonly #client: Database.Database;
  readonly #db: BetterSQLite3Database;

  private constructor(client: Database.Database) {
    this.#client = client;
    this.#db = drizzle(client);
  }

  /** Opens (creating if absent) the store at `path` and brings its schema up to date. */
  static open(path: string, migrationsFolder: string = MIGRATIONS_FOLDER): SqliteCredentialStore {
    const client = new Database(path);
    try {
      client.pragma('journal_mode = WAL');
      client.pragma('synchronous = FULL');
      migrate(drizzle(client), { migrationsFolder });
    } catch (err) {
      client.close();
      throw err;
    }
    return new SqliteCredentialStore(client);
  }

  lookup(keyId: string): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.get(keyId));
  }

  get(keyId: string): StoredCredential | undefined {
    const row = this.#db.select().from(credentials).where(eq(credentials.keyId, keyId)).get();
    return row === undefined ? undefined : { ...row };
  }

  /**
   * Records a new credential. Refuses a key id that has ever been minted,
   * whatever its state, rather than overwriting it.
   */
  insert(credential: NewCredential): InsertResult {
    const inserted = this.#db
      .insert(credentials)
      .values({ ...credential, state: 'active' })
      .onConflictDoNothing({ target: credentials.keyId })
      .returning()
      .all();
    const row = inserted[0];
    if (row === undefined) return { ok: false, reason: 'key-id-taken' };
    return { ok: true, credential: { ...row } };
  }

  /** Moves an active credential to disabled. A credential not active is left as it is. */
  disable(keyId: string): DisableResult {
    const updated = this.#db
      .update(credentials)
      .set({ state: 'disabled' })
      .where(and(eq(credentials.keyId, keyId), eq(credentials.state, 'active')))
      .returning({ keyId: credentials.keyId })
      .all();
    if (updated.length === 1) return 'disabled';
    return this.get(keyId) === undefined ? 'unknown' : 'not-active';
  }

  close(): void {
    this.#client.close();
  }
}

import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { TenantUsageRow, UsageSink } from './meter.js';
import { multipartParts, usageCounters, writeLedger } from './schema.js';

/** Where drizzle-kit writes the ledger's migrations: the same path from `src/usage/` and `dist/usage/`. */
export const USAGE_MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../drizzle/usage', import.meta.url)
);

/** One object name a tenant wrote, with when and how big. */
export interface LedgerEntry {
  readonly keyId: string;
  readonly folder: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly size: number;
  readonly operation: string;
  readonly writtenAt: string;
}

/** One object name with its latest write. */
export interface LedgerObject {
  readonly objectKey: string;
  readonly size: number;
  readonly writtenAt: string;
  readonly writes: number;
}

/**
 * The durable record of every object name written, one row per write, never
 * updated or deleted. It lives in its own SQLite file, committed with
 * `synchronous = FULL`, so a row returned from {@link recordWrite} survives a
 * crash or a restart. Erasure is checked against it.
 */
export class SqliteWriteLedger implements UsageSink {
  readonly #client: Database.Database;
  readonly #db: BetterSQLite3Database;

  private constructor(client: Database.Database) {
    this.#client = client;
    this.#db = drizzle(client);
  }

  static open(path: string, migrationsFolder: string = USAGE_MIGRATIONS_FOLDER): SqliteWriteLedger {
    const client = new Database(path);
    try {
      client.pragma('journal_mode = WAL');
      client.pragma('synchronous = FULL');
      migrate(drizzle(client), { migrationsFolder });
    } catch (err) {
      client.close();
      throw err;
    }
    return new SqliteWriteLedger(client);
  }

  recordWrite(entry: LedgerEntry): void {
    this.#db.insert(writeLedger).values(entry).run();
  }

  /** Every write for a folder, oldest first. */
  listWrites(folder: string): LedgerEntry[] {
    return this.#db
      .select({
        keyId: writeLedger.keyId,
        folder: writeLedger.folder,
        bucket: writeLedger.bucket,
        objectKey: writeLedger.objectKey,
        size: writeLedger.size,
        operation: writeLedger.operation,
        writtenAt: writeLedger.writtenAt,
      })
      .from(writeLedger)
      .where(eq(writeLedger.folder, folder))
      .orderBy(asc(writeLedger.id))
      .all();
  }

  /** Each object name a folder has written, with its latest size and time. */
  listObjects(folder: string): LedgerObject[] {
    const latest = this.#db
      .select({
        objectKey: writeLedger.objectKey,
        lastId: max(writeLedger.id).as('last_id'),
        writes: count().as('writes'),
      })
      .from(writeLedger)
      .where(eq(writeLedger.folder, folder))
      .groupBy(writeLedger.objectKey)
      .as('latest');
    return this.#db
      .select({
        objectKey: writeLedger.objectKey,
        size: writeLedger.size,
        writtenAt: writeLedger.writtenAt,
        writes: latest.writes,
      })
      .from(writeLedger)
      .innerJoin(latest, eq(writeLedger.id, latest.lastId))
      .orderBy(asc(writeLedger.objectKey))
      .all();
  }

  /** The names in `listedKeys` that the ledger has no write for: a planted or unrecorded object. */
  findUnrecorded(folder: string, listedKeys: readonly string[]): string[] {
    const known = new Set(this.listObjects(folder).map((o) => o.objectKey));
    return listedKeys.filter((key) => !known.has(key));
  }

  /** Remembers a part's size, replacing an earlier upload of the same part number. */
  addPart(keyId: string, uploadId: string, partNumber: number, size: number): void {
    this.#db
      .insert(multipartParts)
      .values({ keyId, uploadId, partNumber, size })
      .onConflictDoUpdate({
        target: [multipartParts.keyId, multipartParts.uploadId, multipartParts.partNumber],
        set: { size },
      })
      .run();
  }

  /** The bytes held in the parts of an upload so far. */
  sumParts(keyId: string, uploadId: string): number {
    const row = this.#db
      .select({ total: sql<number>`COALESCE(SUM(${multipartParts.size}), 0)` })
      .from(multipartParts)
      .where(and(eq(multipartParts.keyId, keyId), eq(multipartParts.uploadId, uploadId)))
      .get();
    return row?.total ?? 0;
  }

  clearParts(keyId: string, uploadId: string): void {
    this.#db
      .delete(multipartParts)
      .where(and(eq(multipartParts.keyId, keyId), eq(multipartParts.uploadId, uploadId)))
      .run();
  }

  addUsage(deltas: readonly TenantUsageRow[]): void {
    this.#db.transaction((tx) => {
      for (const d of deltas) {
        tx.insert(usageCounters)
          .values({
            keyId: d.keyId,
            operation: d.operation,
            requests: d.requests,
            billableIn: d.billableBytesIn,
            billableOut: d.billableBytesOut,
          })
          .onConflictDoUpdate({
            target: [usageCounters.keyId, usageCounters.operation],
            set: {
              requests: sql`${usageCounters.requests} + excluded.requests`,
              billableIn: sql`${usageCounters.billableIn} + excluded.billable_in`,
              billableOut: sql`${usageCounters.billableOut} + excluded.billable_out`,
            },
          })
          .run();
      }
    });
  }

  loadUsage(): TenantUsageRow[] {
    return this.#db
      .select({
        keyId: usageCounters.keyId,
        operation: usageCounters.operation,
        requests: usageCounters.requests,
        billableBytesIn: usageCounters.billableIn,
        billableBytesOut: usageCounters.billableOut,
      })
      .from(usageCounters)
      .all();
  }

  /** The connection's commit settings, so a test or a start-up check can see them. */
  durability(): {
    readonly synchronous: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
    readonly journalMode: string;
  } {
    const level = this.#client.pragma('synchronous', { simple: true }) as number;
    return {
      synchronous: (['OFF', 'NORMAL', 'FULL', 'EXTRA'] as const)[level] ?? 'OFF',
      journalMode: this.#client.pragma('journal_mode', { simple: true }) as string,
    };
  }

  close(): void {
    this.#client.close();
  }
}

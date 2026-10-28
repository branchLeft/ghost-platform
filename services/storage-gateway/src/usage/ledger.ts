import Database from 'better-sqlite3';
import type { TenantUsageRow, UsageSink } from './meter.js';

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS write_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  operation TEXT NOT NULL,
  written_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS write_ledger_by_folder ON write_ledger (folder, object_key);
CREATE TABLE IF NOT EXISTS multipart_parts (
  key_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  PRIMARY KEY (key_id, upload_id, part_number)
);
CREATE TABLE IF NOT EXISTS usage_counters (
  key_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  requests INTEGER NOT NULL,
  billable_in INTEGER NOT NULL,
  billable_out INTEGER NOT NULL,
  PRIMARY KEY (key_id, operation)
);
`;

/**
 * The durable record of every object name written, one row per write, never
 * updated or deleted. It lives in its own SQLite file, committed with
 * `synchronous = FULL`, so a row returned from {@link recordWrite} survives a
 * crash or a restart. Erasure is checked against it.
 */
export class SqliteWriteLedger implements UsageSink {
  readonly #client: Database.Database;

  private constructor(client: Database.Database) {
    this.#client = client;
  }

  static open(path: string): SqliteWriteLedger {
    const client = new Database(path);
    try {
      client.pragma('journal_mode = WAL');
      client.pragma('synchronous = FULL');
      client.exec(SCHEMA);
    } catch (err) {
      client.close();
      throw err;
    }
    return new SqliteWriteLedger(client);
  }

  recordWrite(entry: LedgerEntry): void {
    this.#client
      .prepare(
        `INSERT INTO write_ledger (key_id, folder, bucket, object_key, size, operation, written_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.keyId,
        entry.folder,
        entry.bucket,
        entry.objectKey,
        entry.size,
        entry.operation,
        entry.writtenAt
      );
  }

  /** Every write for a folder, oldest first. */
  listWrites(folder: string): LedgerEntry[] {
    return (
      this.#client
        .prepare(
          `SELECT key_id, folder, bucket, object_key, size, operation, written_at
           FROM write_ledger WHERE folder = ? ORDER BY id`
        )
        .all(folder) as Record<string, string | number>[]
    ).map((r) => ({
      keyId: r.key_id as string,
      folder: r.folder as string,
      bucket: r.bucket as string,
      objectKey: r.object_key as string,
      size: r.size as number,
      operation: r.operation as string,
      writtenAt: r.written_at as string,
    }));
  }

  /** Each object name a folder has written, with its latest size and time. */
  listObjects(folder: string): LedgerObject[] {
    return (
      this.#client
        .prepare(
          `SELECT w.object_key AS object_key, w.size AS size, w.written_at AS written_at,
                  (SELECT COUNT(*) FROM write_ledger c
                    WHERE c.folder = w.folder AND c.object_key = w.object_key) AS writes
           FROM write_ledger w
           WHERE w.folder = ? AND w.id = (SELECT MAX(id) FROM write_ledger l
                                           WHERE l.folder = w.folder AND l.object_key = w.object_key)
           ORDER BY w.object_key`
        )
        .all(folder) as Record<string, string | number>[]
    ).map((r) => ({
      objectKey: r.object_key as string,
      size: r.size as number,
      writtenAt: r.written_at as string,
      writes: r.writes as number,
    }));
  }

  /** The names in `listedKeys` that the ledger has no write for: a planted or unrecorded object. */
  findUnrecorded(folder: string, listedKeys: readonly string[]): string[] {
    const known = new Set(this.listObjects(folder).map((o) => o.objectKey));
    return listedKeys.filter((key) => !known.has(key));
  }

  /** Remembers a part's size, replacing an earlier upload of the same part number. */
  addPart(keyId: string, uploadId: string, partNumber: number, size: number): void {
    this.#client
      .prepare(
        `INSERT OR REPLACE INTO multipart_parts (key_id, upload_id, part_number, size)
         VALUES (?, ?, ?, ?)`
      )
      .run(keyId, uploadId, partNumber, size);
  }

  /** The bytes held in the parts of an upload so far. */
  sumParts(keyId: string, uploadId: string): number {
    const row = this.#client
      .prepare(
        'SELECT COALESCE(SUM(size), 0) AS total FROM multipart_parts WHERE key_id = ? AND upload_id = ?'
      )
      .get(keyId, uploadId) as { total: number };
    return row.total;
  }

  clearParts(keyId: string, uploadId: string): void {
    this.#client
      .prepare('DELETE FROM multipart_parts WHERE key_id = ? AND upload_id = ?')
      .run(keyId, uploadId);
  }

  addUsage(deltas: readonly TenantUsageRow[]): void {
    const upsert = this.#client.prepare(
      `INSERT INTO usage_counters (key_id, operation, requests, billable_in, billable_out)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key_id, operation) DO UPDATE SET
         requests = requests + excluded.requests,
         billable_in = billable_in + excluded.billable_in,
         billable_out = billable_out + excluded.billable_out`
    );
    this.#client.transaction(() => {
      for (const d of deltas) {
        upsert.run(d.keyId, d.operation, d.requests, d.billableBytesIn, d.billableBytesOut);
      }
    })();
  }

  loadUsage(): TenantUsageRow[] {
    return (
      this.#client
        .prepare(
          'SELECT key_id, operation, requests, billable_in, billable_out FROM usage_counters'
        )
        .all() as Record<string, string | number>[]
    ).map((r) => ({
      keyId: r.key_id as string,
      operation: r.operation as string,
      requests: r.requests as number,
      billableBytesIn: r.billable_in as number,
      billableBytesOut: r.billable_out as number,
    }));
  }

  close(): void {
    this.#client.close();
  }
}

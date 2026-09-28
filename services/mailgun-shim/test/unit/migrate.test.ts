import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureReason, MIGRATIONS_FOLDER, migrateStore } from '../../src/migrate.js';
import * as schema from '../../src/schema.js';
import { createSqliteStore } from '../../src/store.js';
import * as preDrain from '../helpers/preDrainSchema.js';
import {
  columnNames,
  createTables,
  ledgerHashes,
  openFixture,
  queueRecipientRows,
  withFixture,
} from '../helpers/sqliteFixtures.js';

const MIGRATIONS = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
const DOMAIN = 'tenant.example.com';

describe('migrateStore — databases older than the ledger, written by a drain-era release', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-migrate-test-'));
    dbPath = join(dir, 'shim.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(tables: object): Promise<void> {
    const { client, db } = openFixture(dbPath);
    try {
      await createTables(db, tables);
      if (!('queueRecipients' in tables)) return;
      db.insert(preDrain.tenants)
        .values({ domain: DOMAIN, apiKeySalt: 'salt', apiKeyHash: 'hash' })
        .run();
      db.insert(schema.queueBatches)
        .values({ batchId: 'b1', domain: DOMAIN, emailId: null, payload: '{}', createdAt: 0 })
        .run();
      db.insert(schema.queueRecipients)
        .values({
          id: '11111111-1111-4111-8111-111111111111',
          batchId: 'b1',
          recipient: 'held@example.com',
          status: 'held',
          drainCount: 2,
          availableAt: 0,
          heldUntil: 30,
        })
        .run();
    } finally {
      client.close();
    }
  }

  it('drain-shaped without sender_domain: records the first two migrations and applies only the third', async () => {
    // The shape every image between the drain handover and this store ran.
    await seed({ ...schema, tenants: preDrain.tenants });

    createSqliteStore(dbPath).close();

    expect(ledgerHashes(dbPath)).toEqual(MIGRATIONS.map((m) => m.hash));
    expect(columnNames(dbPath, 'tenants')).toContain('sender_domain');
    // The existing drain row keeps its id, lease and generation: nothing re-ran over it.
    expect(queueRecipientRows(dbPath)).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', recipient: 'held@example.com', status: 'held' },
    ]);
    const store = createSqliteStore(dbPath);
    try {
      expect(
        store.ackDrain([{ id: '11111111-1111-4111-8111-111111111111', drainCount: 2 }], 1).acked
      ).toEqual(['11111111-1111-4111-8111-111111111111']);
    } finally {
      store.close();
    }
  });

  it('already fully current: records every migration and runs none', async () => {
    await seed(schema);
    const columnsBefore = columnNames(dbPath, 'tenants');

    createSqliteStore(dbPath).close();

    expect(ledgerHashes(dbPath)).toEqual(MIGRATIONS.map((m) => m.hash));
    expect(columnNames(dbPath, 'tenants')).toEqual(columnsBefore);
    expect(queueRecipientRows(dbPath)).toHaveLength(1);
  });

  it('refuses a baseline migration holding a statement that creates nothing, changing nothing', async () => {
    const folder = join(dir, 'drizzle');
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const baseline = join(folder, '0000_pre_drain_baseline.sql');
    writeFileSync(
      baseline,
      `${readFileSync(baseline, 'utf8')}\n--> statement-breakpoint\nDELETE FROM \`tenants\`;`
    );
    await seed({ tenants: preDrain.tenants });

    const { client } = openFixture(dbPath);
    try {
      expect(() => migrateStore(client, folder)).toThrow(
        /baseline migration holds a statement that creates nothing: \s*DELETE FROM/
      );
    } finally {
      client.close();
    }
    expect(columnNames(dbPath, 'tenants')).not.toContain('sender_domain');
    withFixture(dbPath, ({ client: c }) => {
      const tables = (c.pragma('table_list') as Array<{ name: string }>).map((t) => t.name);
      expect(tables).not.toContain('__drizzle_migrations');
      expect(tables).not.toContain('events');
    });
  });
});

describe('failureReason', () => {
  it("prefers the wrapped cause's message: SQLite's own reason, not drizzle's wrapper", () => {
    const err = new Error('Failed to run the query', { cause: new Error('no such column: x') });
    expect(failureReason(err)).toBe('no such column: x');
  });

  it("falls back to the error's own message when it wraps nothing", () => {
    expect(failureReason(new Error('disk I/O error'))).toBe('disk I/O error');
  });

  it('falls back to the error itself when the cause is not an Error', () => {
    expect(failureReason(new Error('outer', { cause: 'a string' }))).toBe('outer');
  });

  it('stringifies a thrown value that is not an Error', () => {
    expect(failureReason('raw failure')).toBe('raw failure');
  });
});

describe('schema.ts', () => {
  it('declares exactly the indexes the migrations create', () => {
    const declared = [schema.events, schema.queueRecipients]
      .flatMap((table) => getTableConfig(table).indexes.map((i) => i.config.name))
      .sort();
    const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-schema-test-'));
    try {
      const dbPath = join(dir, 'shim.sqlite');
      createSqliteStore(dbPath).close();
      const created = withFixture(dbPath, ({ client }) =>
        [
          ...(client.pragma('index_list(events)') as Array<{ name: string; origin: string }>),
          ...(client.pragma('index_list(queue_recipients)') as Array<{
            name: string;
            origin: string;
          }>),
        ]
          .filter((i) => i.origin === 'c')
          .map((i) => i.name)
          .sort()
      );
      expect(declared).toEqual(created);
      // Composite primary keys are declared too, and match.
      expect(
        getTableConfig(schema.suppressions).primaryKeys[0]!.columns.map((c) => c.name)
      ).toEqual(['domain', 'type', 'email']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

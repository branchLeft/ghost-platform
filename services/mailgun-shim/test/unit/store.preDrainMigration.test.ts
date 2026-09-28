import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, migrationsLedger } from '../../src/migrate.js';
import { createDrainRouter } from '../../src/routes/drain.js';
import { createDrainWake } from '../../src/drainWake.js';
import { queueRecipients } from '../../src/schema.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import * as preDrain from '../helpers/preDrainSchema.js';
import {
  columnNames,
  createTables,
  ledgerHashes,
  openFixture,
  queueRecipientRows,
  tableNames,
  withFixture,
} from '../helpers/sqliteFixtures.js';
import { createTestLogger, type TestLogger } from '../helpers/testLogger.js';
import { createUnlimitedThrottle } from '../helpers/testThrottle.js';
import { startRouter, type StartedRouter } from './helpers/startRouter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const storeJsPath = join(projectRoot, 'dist', 'store.js');
const holdMigrationOpenPath = join(__dirname, '..', 'helpers', 'holdMigrationOpen.mjs');

const DOMAIN = 'tenant1.example.com';
const DRAIN_TOKEN = 'pre-drain-migration-test-token';
const MIGRATIONS = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function preDrainPayload(): string {
  return JSON.stringify({
    from: 'noreply@tenant1.example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: 'hi',
    headers: {},
    recipientVariables: {},
  });
}

type PreDrainRecipient = typeof preDrain.queueRecipients.$inferInsert;

// Two states no release ever wrote, so no migration can account for them.
const halfRenamedQueue = sqliteTable('queue_recipients', {
  batchId: text('batch_id').notNull(),
  recipient: text('recipient').notNull(),
  status: text('status').notNull().default('pending'),
  drainCount: integer('drain_count').notNull().default(0),
  nextAttemptAt: real('next_attempt_at').notNull(),
  lastError: text('last_error'),
});
const doubledCounterQueue = sqliteTable('queue_recipients', {
  batchId: text('batch_id').notNull(),
  recipient: text('recipient').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  drainCount: integer('drain_count'),
  nextAttemptAt: real('next_attempt_at').notNull(),
  lastError: text('last_error'),
});

/**
 * A pre-drain database with one tenant and one batch holding a recipient in
 * each of the old model's four states: the point every assertion here starts from.
 */
async function seedPreDrainDatabase(
  dbPath: string,
  extraRecipients: PreDrainRecipient[] = []
): Promise<void> {
  const { client, db } = openFixture(dbPath);
  try {
    await createTables(db, preDrain);
    db.insert(preDrain.tenants)
      .values({ domain: DOMAIN, apiKeySalt: 'pre-drain-salt', apiKeyHash: 'pre-drain-hash' })
      .run();
    db.insert(preDrain.queueBatches)
      .values({
        batchId: 'batch-mixed',
        domain: DOMAIN,
        emailId: null,
        payload: preDrainPayload(),
        createdAt: 0,
      })
      .run();
    const row = (
      recipient: string,
      status: string,
      attempts: number,
      lastError: string | null
    ) => ({
      batchId: 'batch-mixed',
      recipient,
      status,
      attempts,
      nextAttemptAt: 0,
      lastError,
    });
    for (const recipient of [
      // Never claimed under the old worker: the row the migration must make drainable.
      row('pending@example.com', 'pending', 0, null),
      // Delivered, exhausted and suppressed: terminal, never to be re-offered.
      row('sent@example.com', 'sent', 1, null),
      row('failed@example.com', 'failed', 6, 'mailbox unavailable'),
      row('suppressed@example.com', 'suppressed', 0, null),
      ...extraRecipients,
    ]) {
      db.insert(preDrain.queueRecipients).values(recipient).run();
    }
  } finally {
    client.close();
  }
}

describe('createSqliteStore — migrating a pre-drain database', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-pre-drain-migration-'));
    dbPath = join(dir, 'shim.sqlite');
    await seedPreDrainDatabase(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function freshFile(): void {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-pre-drain-migration-'));
    dbPath = join(dir, 'shim.sqlite');
  }

  it('opens the pre-drain database without throwing', () => {
    let store: ShimStore | undefined;
    expect(() => {
      store = createSqliteStore(dbPath);
    }).not.toThrow();
    store?.close();
  });

  it('migrates queue_recipients to the drain shape: id column present, unique, every row backfilled', () => {
    const store = createSqliteStore(dbPath);
    store.close();

    const columns = columnNames(dbPath, 'queue_recipients');
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'batch_id',
        'recipient',
        'status',
        'drain_count',
        'available_at',
        'held_until',
        'last_error',
      ])
    );
    expect(columns).not.toContain('attempts');
    expect(columns).not.toContain('next_attempt_at');

    const rows = queueRecipientRows(dbPath);
    expect(rows).toHaveLength(4);
    const ids = rows.map((r) => r.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(4); // every id unique
  });

  it('backfills ids in the same shape a freshly enqueued row gets', () => {
    createSqliteStore(dbPath).close();
    for (const { id } of queueRecipientRows(dbPath)) {
      expect(id).toMatch(UUID_V4);
    }
  });

  it('records the baseline as already applied, then applies every later migration, in order', () => {
    createSqliteStore(dbPath).close();
    expect(ledgerHashes(dbPath)).toEqual(MIGRATIONS.map((m) => m.hash));
    expect(columnNames(dbPath, 'tenants')).toContain('sender_domain');
  });

  it('carries each old counter over under its new name, and keeps last_error', async () => {
    freshFile();
    await seedPreDrainDatabase(dbPath, [
      {
        batchId: 'batch-mixed',
        recipient: 'retried@example.com',
        status: 'pending',
        attempts: 3,
        nextAttemptAt: 5000,
        lastError: '421 try later',
      },
    ]);
    const store = createSqliteStore(dbPath);
    try {
      expect(store.claimForDrain(100, 30, 10).map((r) => r.recipient)).toEqual([
        'pending@example.com',
      ]);
      const retried = store
        .claimForDrain(6000, 30, 10)
        .find((r) => r.recipient === 'retried@example.com');
      expect(retried?.drainCount).toBe(4);
    } finally {
      store.close();
    }
    const lastError = withFixture(dbPath, ({ db }) =>
      db
        .select({ lastError: queueRecipients.lastError })
        .from(queueRecipients)
        .where(eq(queueRecipients.recipient, 'retried@example.com'))
        .get()
    );
    expect(lastError).toEqual({ lastError: '421 try later' });
  });

  it('keeps enqueue order within a batch across the table rebuild', async () => {
    freshFile();
    await seedPreDrainDatabase(dbPath, [
      { batchId: 'batch-mixed', recipient: 'zz@example.com', status: 'pending', nextAttemptAt: 0 },
      { batchId: 'batch-mixed', recipient: 'aa@example.com', status: 'pending', nextAttemptAt: 0 },
    ]);
    const store = createSqliteStore(dbPath);
    try {
      expect(store.claimForDrain(1, 30, 10).map((r) => r.recipient)).toEqual([
        'pending@example.com',
        'zz@example.com',
        'aa@example.com',
      ]);
    } finally {
      store.close();
    }
  });

  it('the tenant survives the migration intact', () => {
    const store = createSqliteStore(dbPath);
    expect(store.tenantExists(DOMAIN)).toBe(true);
    expect(store.listTenants().map((entry) => entry.domain)).toEqual([DOMAIN]);
    store.close();
  });

  it('the migrated pending row is drainable and acks once; finished rows are never offered', () => {
    const store = createSqliteStore(dbPath);

    // Only the pending row comes back — sent/failed/suppressed are terminal.
    const drained = store.claimForDrain(1_000_000, 30, 10);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.recipient).toBe('pending@example.com');
    // attempts=0 carries over as drain_count=0, so this first claim makes it 1.
    expect(drained[0]!.drainCount).toBe(1);

    const ackResult = store.ackDrain(
      [{ id: drained[0]!.id, drainCount: drained[0]!.drainCount }],
      1_000_001
    );
    expect(ackResult.acked).toEqual([drained[0]!.id]);

    expect(store.claimForDrain(2_000_000, 30, 10)).toHaveLength(0);
    expect(store.countUndrainedRecipients()).toBe(0);

    store.close();
  });

  it('the migrated pending row is drainable and acked through the real GET /drain and POST /drain/ack routes', async () => {
    const store = createSqliteStore(dbPath);
    const wake = createDrainWake();
    const testLogger: TestLogger = createTestLogger();
    let server: StartedRouter | undefined;

    try {
      server = await startRouter(
        createDrainRouter(
          store,
          wake,
          DRAIN_TOKEN,
          { holdMs: 200, leaseSeconds: 30, batchLimit: 10, pollIntervalMs: 20 },
          testLogger.logger,
          createUnlimitedThrottle()
        )
      );

      const drainResponse = await fetch(`${server.baseUrl}/drain`, {
        headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
      });
      expect(drainResponse.status).toBe(200);
      const drainBody = (await drainResponse.json()) as {
        messages: Array<{ id: string; to: string; drainCount: number }>;
      };
      expect(drainBody.messages).toHaveLength(1);
      expect(drainBody.messages[0]!.to).toBe('pending@example.com');

      const ackResponse = await fetch(`${server.baseUrl}/drain/ack`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DRAIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          acks: [{ id: drainBody.messages[0]!.id, drainCount: drainBody.messages[0]!.drainCount }],
        }),
      });
      expect(ackResponse.status).toBe(200);
      const ackBody = (await ackResponse.json()) as { acked: string[] };
      expect(ackBody.acked).toEqual([drainBody.messages[0]!.id]);

      // Finished mail (including the row just acked) is never re-offered.
      const secondDrain = await fetch(`${server.baseUrl}/drain`, {
        headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
      });
      const secondBody = (await secondDrain.json()) as { messages: unknown[] };
      expect(secondBody.messages).toEqual([]);
    } finally {
      await server?.close();
      store.close();
    }
  });

  it('idempotence: opening an already-migrated database a second time is a no-op', () => {
    const first = createSqliteStore(dbPath);
    first.close();
    const beforeColumns = columnNames(dbPath, 'queue_recipients').sort();
    const beforeRows = queueRecipientRows(dbPath);
    const beforeLedger = ledgerHashes(dbPath);

    let second: ShimStore | undefined;
    expect(() => {
      second = createSqliteStore(dbPath);
    }).not.toThrow();
    second?.close();

    expect(columnNames(dbPath, 'queue_recipients').sort()).toEqual(beforeColumns);
    // Ids are stable across the no-op second open, not re-minted.
    expect(queueRecipientRows(dbPath)).toEqual(beforeRows);
    expect(ledgerHashes(dbPath)).toEqual(beforeLedger);
  });

  it('a fresh database is unaffected: it runs every migration and gets the drain-shaped table', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'mailgun-shim-fresh-'));
    const freshDbPath = join(freshDir, 'shim.sqlite');
    try {
      const store = createSqliteStore(freshDbPath);
      store.enqueueBatch({
        batchId: 'batch-fresh',
        domain: DOMAIN,
        emailId: null,
        payload: {
          from: 'noreply@tenant1.example.com',
          subject: 'Hi',
          html: '<p>hi</p>',
          text: 'hi',
          headers: {},
          recipientVariables: {},
        },
        recipients: ['fresh@example.com'],
        now: 0,
      });
      const drained = store.claimForDrain(0, 30, 10);
      expect(drained).toHaveLength(1);
      expect(drained[0]!.id).toBeTruthy();
      store.close();

      const columns = columnNames(freshDbPath, 'queue_recipients');
      expect(columns).toContain('id');
      expect(columns).not.toContain('attempts');
      expect(ledgerHashes(freshDbPath)).toEqual(MIGRATIONS.map((m) => m.hash));
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['attempts already renamed to drain_count, nothing else converted', halfRenamedQueue],
    ['drain_count added alongside a still-present attempts', doubledCounterQueue],
  ])(
    'refuses a shape the history cannot account for, changing nothing: %s',
    async (_name, queue) => {
      freshFile();
      const { client, db } = openFixture(dbPath);
      try {
        await createTables(db, { ...preDrain, queueRecipients: queue });
      } finally {
        client.close();
      }
      const before = columnNames(dbPath, 'queue_recipients');

      expect(() => createSqliteStore(dbPath)).toThrow(/Unrecognised schema/);
      expect(columnNames(dbPath, 'queue_recipients')).toEqual(before);
      expect(tableNames(dbPath)).not.toContain('__drizzle_migrations');
    }
  );

  it('a migration that fails part-way rolls the whole open back: nothing recorded, nothing changed', () => {
    // The ledger claims the baseline, but the table no longer has the column
    // the conversion reads, so the conversion's copy fails mid-transaction.
    createSqliteStore(dbPath).close();
    withFixture(dbPath, ({ db }) => {
      db.delete(migrationsLedger).where(eq(migrationsLedger.hash, MIGRATIONS[1]!.hash)).run();
      db.delete(migrationsLedger).where(eq(migrationsLedger.hash, MIGRATIONS[2]!.hash)).run();
    });
    const rowsBefore = queueRecipientRows(dbPath);

    expect(() => createSqliteStore(dbPath)).toThrow(/^Migration 1 failed: no such column/);
    expect(ledgerHashes(dbPath)).toEqual([MIGRATIONS[0]!.hash]);
    expect(queueRecipientRows(dbPath)).toEqual(rowsBefore);
    expect(tableNames(dbPath)).not.toContain('__new_queue_recipients');
  });

  it('a write lock held past the busy timeout still propagates', () => {
    // A second connection holds an uncommitted write for the whole open: the
    // one wait the store does not swallow.
    const holder = openFixture(dbPath);
    const HOLD = new Error('rolled back on purpose');
    try {
      expect(() =>
        holder.db.transaction(
          (tx) => {
            tx.update(preDrain.queueRecipients)
              .set({ lastError: 'held' })
              .where(eq(preDrain.queueRecipients.recipient, 'pending@example.com'))
              .run();
            expect(() => createSqliteStore(dbPath)).toThrow(/database is locked|SQLITE_BUSY/i);
            throw HOLD;
          },
          { behavior: 'immediate' }
        )
      ).toThrow(HOLD);
    } finally {
      holder.client.close();
    }
  }, 20_000);

  it('a second opener caught mid-migration waits for it, then finds nothing left to do', async () => {
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
    const child = spawn(process.execPath, [holdMigrationOpenPath, dbPath, '1500'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('migrated-uncommitted')) resolve();
      });
      child.on('exit', (code) => reject(new Error(`holder exited ${code}: ${stderr}`)));
    });

    const store = createSqliteStore(dbPath);
    store.close();
    expect(await exited).toBe(0);

    expect(ledgerHashes(dbPath)).toEqual(MIGRATIONS.map((m) => m.hash));
    const rows = queueRecipientRows(dbPath);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
  }, 20_000);

  it('concurrency: two real processes opening the same pre-drain database at once both succeed, and the result is a single, correctly migrated table', async () => {
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });

    const openScript = `
      import { createSqliteStore } from ${JSON.stringify(storeJsPath)};
      const store = createSqliteStore(${JSON.stringify(dbPath)});
      store.close();
      process.exit(0);
    `;

    const results = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<number>((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', openScript], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString('utf8');
            });
            child.on('exit', (code) => {
              if (code !== 0) {
                reject(new Error(`opener process exited ${code}: ${stderr}`));
                return;
              }
              resolve(code);
            });
            child.on('error', reject);
          })
      )
    );

    expect(results).toEqual([0, 0]);

    expect(columnNames(dbPath, 'queue_recipients')).toContain('id');
    const rows = queueRecipientRows(dbPath);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(ledgerHashes(dbPath)).toEqual(MIGRATIONS.map((m) => m.hash));
  }, 20_000);
});

describe('src/server.ts — starts against a pre-drain database and serves /metrics', () => {
  let dir: string;

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        if (!address || typeof address === 'string') {
          reject(new Error('could not determine a free port'));
          return;
        }
        const { port } = address;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  it('boots against a pre-drain database and serves /metrics', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-pre-drain-server-'));
    const dbPath = join(dir, 'shim.sqlite');
    await seedPreDrainDatabase(dbPath);

    const port = await findFreePort();
    const smtpPort = await findFreePort();

    const child = spawn(process.execPath, [serverJsPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SHIM_DB_PATH: dbPath,
        SHIM_DRAIN_TOKEN: 'pre-drain-server-startup-token',
        PORT: String(port),
        SMTP_LISTEN_PORT: String(smtpPort),
        SMTP_LISTEN_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = (): void => {
          if (stdout.includes('"event":"listening"')) {
            resolve();
            return;
          }
          if (child.exitCode !== null) {
            reject(new Error(`server exited early (code ${child.exitCode}). stderr:\n${stderr}`));
            return;
          }
          if (Date.now() > deadline) {
            reject(
              new Error(`server never logged "listening". stdout:\n${stdout}\nstderr:\n${stderr}`)
            );
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });

      const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metricsResponse.status).toBe(200);
    } finally {
      const exitPromise = new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });
      child.kill('SIGTERM');
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000)
        ),
      ]);
    }
  }, 20_000);
});

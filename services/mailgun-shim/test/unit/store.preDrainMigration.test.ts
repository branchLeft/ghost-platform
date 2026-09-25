import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrainRouter } from '../../src/routes/drain.js';
import { createDrainWake } from '../../src/drainWake.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import { createTestLogger, type TestLogger } from '../helpers/testLogger.js';
import { createUnlimitedThrottle } from '../helpers/testThrottle.js';
import { startRouter, type StartedRouter } from './helpers/startRouter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const storeJsPath = join(projectRoot, 'dist', 'store.js');

const DOMAIN = 'tenant1.example.com';
const DRAIN_TOKEN = 'pre-drain-migration-test-token';

/**
 * Every column and index literally as they exist at commit a273acb1da1c0900afae8bb2ee73dd3343819392
 * — mx1's live shape today, from before #238's drain handover. Kept
 * independent of anything in src/store.ts on purpose: if a future edit
 * changes the *current* schema again, this fixture must still describe the
 * *old* one, otherwise the migration it exercises stops meaning anything.
 */
function createPreDrainSchema(db: DatabaseSync): void {
  // The pre-#238 store (a273acb) already switches every database it opens
  // to WAL — mx1's real file has been in WAL mode since the old worker
  // first ran against it, never DELETE mode. Matching that here (rather
  // than leaving this fixture in sqlite's DELETE default) is what makes
  // the two-real-processes test below a genuine reproduction of the
  // production race — the queue_recipients migration's own lock
  // contention — instead of a first-time WAL-mode-switch race neither
  // process would actually hit against mx1's real file.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      domain TEXT PRIMARY KEY,
      api_key_salt TEXT NOT NULL,
      api_key_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT,
      recipient TEXT NOT NULL,
      email_id TEXT,
      provider_message_id TEXT,
      timestamp REAL NOT NULL,
      error_code INTEGER,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_domain_seq ON events (domain, seq);

    CREATE TABLE IF NOT EXISTS suppressions (
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (domain, type, email)
    );

    CREATE TABLE IF NOT EXISTS queue_batches (
      batch_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      email_id TEXT,
      payload TEXT NOT NULL,
      created_at REAL NOT NULL,
      completed_at REAL
    );

    CREATE TABLE IF NOT EXISTS queue_recipients (
      batch_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at REAL NOT NULL,
      last_error TEXT,
      PRIMARY KEY (batch_id, recipient)
    );

    CREATE INDEX IF NOT EXISTS idx_queue_recipients_status_next
      ON queue_recipients (status, next_attempt_at);
  `);
}

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

/**
 * A database with the exact a273acb schema, one tenant, and one batch
 * carrying a recipient in each of the old model's four states — the fixed
 * point every assertion in this file starts from.
 */
function seedPreDrainDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    createPreDrainSchema(db);
    db.prepare('INSERT INTO tenants (domain, api_key_salt, api_key_hash) VALUES (?, ?, ?)').run(
      DOMAIN,
      'pre-drain-salt',
      'pre-drain-hash'
    );

    db.prepare(
      'INSERT INTO queue_batches (batch_id, domain, email_id, payload, created_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run('batch-mixed', DOMAIN, null, preDrainPayload(), 0);

    const insertRecipient = db.prepare(
      'INSERT INTO queue_recipients (batch_id, recipient, status, attempts, next_attempt_at, last_error) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // Never claimed under the old worker — the row this migration must
    // make drainable.
    insertRecipient.run('batch-mixed', 'pending@example.com', 'pending', 0, 0, null);
    // Already delivered under the old worker — must never be re-offered.
    insertRecipient.run('batch-mixed', 'sent@example.com', 'sent', 1, 0, null);
    // Exhausted its retries under the old worker — terminal, must never be
    // re-offered.
    insertRecipient.run('batch-mixed', 'failed@example.com', 'failed', 6, 0, 'mailbox unavailable');
    // Suppressed before the old worker ever sent it — terminal, must never
    // be re-offered.
    insertRecipient.run('batch-mixed', 'suppressed@example.com', 'suppressed', 0, 0, null);
  } finally {
    db.close();
  }
}

function tableInfo(dbPath: string, table: string): Array<{ name: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  } finally {
    db.close();
  }
}

function queueRecipientRows(
  dbPath: string
): Array<{ id: string | null; recipient: string; status: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare('SELECT id, recipient, status FROM queue_recipients ORDER BY recipient')
      .all() as Array<{ id: string | null; recipient: string; status: string }>;
  } finally {
    db.close();
  }
}

describe('createSqliteStore — migrating a pre-#238 (pre-drain) database', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-pre-drain-migration-'));
    dbPath = join(dir, 'shim.sqlite');
    seedPreDrainDatabase(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the pre-#238 database without throwing', () => {
    let store: ShimStore | undefined;
    expect(() => {
      store = createSqliteStore(dbPath);
    }).not.toThrow();
    store?.close();
  });

  it('migrates queue_recipients to the drain shape: id column present, unique, every row backfilled', () => {
    const store = createSqliteStore(dbPath);
    store.close();

    const columns = tableInfo(dbPath, 'queue_recipients').map((c) => c.name);
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

  it('the tenant survives the migration intact', async () => {
    const store = createSqliteStore(dbPath);
    expect(store.tenantExists(DOMAIN)).toBe(true);
    expect(store.listTenants()).toEqual([DOMAIN]);
    store.close();
  });

  it('the migrated pending row is drainable and acks once; finished rows are never offered', () => {
    const store = createSqliteStore(dbPath);

    // Only the pending row comes back — sent/failed/suppressed are terminal.
    const drained = store.claimForDrain(1_000_000, 30, 10);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.recipient).toBe('pending@example.com');
    // attempts=0 in the old row -> drain_count=0 inherited -> this claim's
    // own increment takes it to 1, same as a freshly-enqueued row's first
    // claim.
    expect(drained[0]!.drainCount).toBe(1);

    const ackResult = store.ackDrain(
      [{ id: drained[0]!.id, drainCount: drained[0]!.drainCount }],
      1_000_001
    );
    expect(ackResult.acked).toEqual([drained[0]!.id]);

    // Nothing left to claim: the newly-acked row and the three
    // already-terminal migrated rows are all resolved.
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
    const beforeColumns = tableInfo(dbPath, 'queue_recipients')
      .map((c) => c.name)
      .sort();
    const beforeRows = queueRecipientRows(dbPath);

    let second: ShimStore | undefined;
    expect(() => {
      second = createSqliteStore(dbPath);
    }).not.toThrow();
    second?.close();

    const afterColumns = tableInfo(dbPath, 'queue_recipients')
      .map((c) => c.name)
      .sort();
    const afterRows = queueRecipientRows(dbPath);
    expect(afterColumns).toEqual(beforeColumns);
    // Ids are stable across the no-op second open, not re-minted.
    expect(afterRows).toEqual(beforeRows);
  });

  it('a fresh (never pre-#238) database is unaffected: it just gets the drain-shaped table directly', () => {
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

      const columns = tableInfo(freshDbPath, 'queue_recipients').map((c) => c.name);
      expect(columns).toContain('id');
      expect(columns).not.toContain('attempts');
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('a genuine, non-race RENAME failure still propagates rather than being swallowed forever (the fail-closed guard)', () => {
    // Doctors the file into a state ensureDrainShapedQueueRecipients would
    // never produce itself: `attempts` already renamed to `drain_count`,
    // but none of the rest of the migration (available_at, held_until,
    // id) has happened. This is NOT what a genuine concurrent winner
    // leaves behind (that migration is one transaction — it is either
    // entirely absent or entirely done, see the two-real-processes test
    // below) — it is deliberately engineered so that createSqliteStore's
    // own RENAME statement fails with exactly the race's error message
    // ("no such column: attempts") while the table still is NOT actually
    // migrated. That proves the catch's re-check is load-bearing, not
    // just an error-message string match: even after seeing the exact
    // expected message, it verifies the table really did land in the new
    // shape before swallowing anything, and re-throws when it hasn't.
    const doctored = new DatabaseSync(dbPath);
    try {
      doctored.exec('PRAGMA busy_timeout = 5000');
      doctored.exec('ALTER TABLE queue_recipients RENAME COLUMN attempts TO drain_count');
    } finally {
      doctored.close();
    }

    expect(() => createSqliteStore(dbPath)).toThrow(/no such column/);
  });

  it('an unrelated schema error during migration propagates as-is — never mistaken for the race', () => {
    // Doctors in a genuinely different failure: `drain_count` already
    // exists alongside the still-present `attempts`, so the real RENAME
    // fails with "duplicate column name", not "no such column" — proving
    // the message check only ever swallows the one specific, harmless
    // race outcome, not schema errors in general.
    const doctored = new DatabaseSync(dbPath);
    try {
      doctored.exec('PRAGMA busy_timeout = 5000');
      doctored.exec('ALTER TABLE queue_recipients ADD COLUMN drain_count INTEGER');
    } finally {
      doctored.close();
    }

    expect(() => createSqliteStore(dbPath)).toThrow(/duplicate column name/);
  });

  it('BEGIN IMMEDIATE genuinely timing out under sustained lock contention still propagates', () => {
    // A second connection holds an open write transaction on the
    // pre-migration file for the whole test (never committed) — standing
    // in for a writer that does not release its lock within the busy
    // timeout at all, the one case ensureDrainShapedQueueRecipients does
    // NOT swallow (see its own doc comment: "a wait that outlasts the
    // busy timeout still propagates").
    const holder = new DatabaseSync(dbPath);
    holder.exec('PRAGMA busy_timeout = 5000');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec(
      "UPDATE queue_recipients SET last_error = 'held' WHERE recipient = 'pending@example.com'"
    );
    try {
      expect(() => createSqliteStore(dbPath)).toThrow(/database is locked|SQLITE_BUSY/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('concurrency: two real processes opening the same pre-#238 database at once both succeed, and the result is a single, correctly migrated table', async () => {
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

    const columns = tableInfo(dbPath, 'queue_recipients').map((c) => c.name);
    expect(columns).toContain('id');
    const rows = queueRecipientRows(dbPath);
    expect(rows).toHaveLength(4);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  }, 20_000);
});

describe('src/server.ts — starts against a pre-#238 database and serves /metrics', () => {
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

  it('boots against a pre-drain-handover database and serves /metrics', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-pre-drain-server-'));
    const dbPath = join(dir, 'shim.sqlite');
    seedPreDrainDatabase(dbPath);

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

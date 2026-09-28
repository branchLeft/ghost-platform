import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { queueBatches } from '../src/schema.js';
import { createSqliteStore } from '../src/store.js';

/**
 * Proves server.ts starts the cleanup scheduler: a 31-day-old batch is gone
 * by "listening" while a 1-day-old control batch survives.
 * See serverStartupCleanup.test.md#the-scheduler-is-wired.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');

const DOMAIN = 'tenant1.example.com';
const RETENTION_SECONDS = 30 * 24 * 3600;

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

function build(): void {
  execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
}

function payload() {
  return {
    from: 'noreply@tenant1.example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: 'hi',
    headers: {},
    recipientVariables: {},
  };
}

/** Enqueues, claims and acks one recipient so the batch is fully terminal, with completed_at backdated to `completedAt`. */
function seedCompletedBatch(
  dbPath: string,
  batchId: string,
  recipient: string,
  completedAt: number
): void {
  const store = createSqliteStore(dbPath);
  store.enqueueBatch({
    batchId,
    domain: DOMAIN,
    emailId: null,
    payload: payload(),
    recipients: [recipient],
    now: completedAt,
  });
  const [drained] = store.claimForDrain(completedAt, 30, 10);
  store.ackDrain([{ id: drained!.id, drainCount: drained!.drainCount }], completedAt);
  store.close();
}

function countBatchRows(dbPath: string, batchId: string): number {
  const client = new Database(dbPath);
  try {
    const row = drizzle(client)
      .select({ c: count() })
      .from(queueBatches)
      .where(eq(queueBatches.batchId, batchId))
      .get();
    return row?.c ?? 0;
  } finally {
    client.close();
  }
}

async function runServerAndWaitForListening(
  dbPath: string,
  port: number,
  smtpPort: number
): Promise<void> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [serverJsPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        SHIM_DB_PATH: dbPath,
        SHIM_DRAIN_TOKEN: 'cleanup-startup-proof-token',
        PORT: String(port),
        // Unset, this defaults to the privileged port 25, which this
        // test's own process cannot bind outside a container granting
        // ip_unprivileged_port_start=0 — the SMTP front door's listen()
        // would fail and crash the child before "listening" ever logs.
        SMTP_LISTEN_PORT: String(smtpPort),
        SMTP_LISTEN_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

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

  // A little past "listening" too, in case a future server.ts reorders
  // things so the scheduler's first tick isn't synchronous with startup
  // any more — this test should stay meaningful even if that changes.
  await new Promise((r) => setTimeout(r, 300));

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

describe('src/server.ts — actually starts the cleanup scheduler (not just imports it)', () => {
  let dir: string;

  beforeAll(() => {
    build();
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a batch completed 31 days ago is gone after startup; a control batch completed 1 day ago survives', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-cleanup-startup-test-'));
    const dbPath = join(dir, 'shim.sqlite');
    const realNow = Date.now() / 1000;
    const oldCompletedAt = realNow - RETENTION_SECONDS - 24 * 3600; // 31 days ago
    const recentCompletedAt = realNow - 24 * 3600; // 1 day ago — control, must survive

    seedCompletedBatch(dbPath, 'old-batch', 'old@example.com', oldCompletedAt);
    seedCompletedBatch(dbPath, 'recent-batch', 'recent@example.com', recentCompletedAt);

    // Sanity: both rows genuinely exist before startup.
    expect(countBatchRows(dbPath, 'old-batch')).toBe(1);
    expect(countBatchRows(dbPath, 'recent-batch')).toBe(1);

    const port = await findFreePort();
    const smtpPort = await findFreePort();
    await runServerAndWaitForListening(dbPath, port, smtpPort);

    expect(countBatchRows(dbPath, 'old-batch')).toBe(0); // swept
    expect(countBatchRows(dbPath, 'recent-batch')).toBe(1); // untouched — the control
  }, 20_000);
});

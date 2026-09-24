import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteStore } from '../src/store.js';

/**
 * test/noOutboundConnection.test.ts proves `createApp()` never dials out,
 * but `src/server.ts` has real top-level code of its own — `loadConfig()`,
 * `createSqliteStore()`, `createThrottle()`, the SIGTERM handler — none of
 * which that test exercises, because it builds the app directly rather
 * than running the actual entrypoint.
 *
 * Review cycle 2 found the first version of this test insufficient even
 * though it caught a top-level dial: the deleted worker never dialled at
 * startup, it dialled once per QUEUED ROW, on a tick loop. A test that
 * enqueues nothing and lives under a second stays green for exactly that
 * shape restored. This version enqueues a real message through the
 * child's own HTTP API (a file-backed store, not `:memory:`, since the
 * property under test is what the real entrypoint does with real state)
 * and keeps the child alive for several seconds afterward — comfortably
 * longer than any plausible tick interval a re-introduced worker loop
 * would use — before asserting silence and only then sending SIGTERM.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const preloadPath = join(__dirname, 'helpers', 'connectGuardPreload.mjs');

const CONNECT_MARKER = 'CONNECT_ATTEMPT ';
const TENANT_DOMAIN = 'tenant1.example.com';
const TENANT_API_KEY = 'startup-proof-api-key';

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

interface RunResult {
  connectAttempts: unknown[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface RunOptions {
  dbPath: string;
  port: number;
  /** Sent as multipart form fields to /v3/:domain/messages right after startup, from THIS (parent, unpatched) process — proves the real request-handling code path, not a direct store write. */
  enqueue?: boolean;
  /** How long to keep the child alive after startup (and after the enqueue, if any) before SIGTERM — long enough to catch a tick-based worker loop, not just a startup-time dial. */
  liveForMs: number;
}

async function runServerLifecycle(opts: RunOptions): Promise<RunResult> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    ['--import', preloadPath, serverJsPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        SHIM_DB_PATH: opts.dbPath,
        SHIM_DRAIN_TOKEN: 'server-startup-proof-token',
        // Short, not the 30s production default — a GET /drain below
        // holds for the whole configured window when nothing is queued.
        SHIM_DRAIN_HOLD_MS: '300',
        PORT: String(opts.port),
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

  const base = `http://127.0.0.1:${opts.port}`;
  await fetch(`${base}/healthz`);
  await fetch(`${base}/metrics`);

  if (opts.enqueue) {
    const form = new FormData();
    form.append('to', 'member@example.com');
    form.append('from', `noreply@${TENANT_DOMAIN}`);
    form.append('subject', 'Hi');
    form.append('html', '<p>hi</p>');
    form.append('text', 'hi');
    form.append('recipient-variables', '{}');
    const auth = Buffer.from(`api:${TENANT_API_KEY}`).toString('base64');
    const enqueueRes = await fetch(`${base}/v3/${TENANT_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });
    if (!enqueueRes.ok) {
      throw new Error(`enqueue failed: ${enqueueRes.status} ${await enqueueRes.text()}`);
    }

    // Sanity check that the enqueue really landed, via the real drain
    // route — this test's job is silence under real queued mail, so it
    // has to confirm the mail was genuinely real and queued, not that the
    // POST merely returned 200.
    const metricsRes = await fetch(`${base}/metrics`);
    const metricsText = await metricsRes.text();
    if (!metricsText.includes('mailgun_shim_undrained_recipients 1')) {
      throw new Error(`enqueue did not register as queued:\n${metricsText}`);
    }
  }

  // Live for several seconds — long enough for a tick-based worker loop
  // (the deleted one ticked every second; a plausible re-introduction
  // would tick at least that often) to have fired multiple times.
  await new Promise((r) => setTimeout(r, opts.liveForMs));

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  child.kill('SIGTERM');
  const exitCode = await Promise.race([
    exitPromise,
    new Promise<number | null>((resolve) =>
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 5000)
    ),
  ]);

  const connectAttempts = stdout
    .split('\n')
    .filter((line) => line.startsWith(CONNECT_MARKER))
    .map((line) => JSON.parse(line.slice(CONNECT_MARKER.length)) as { kind: string });

  return { connectAttempts, stdout, stderr, exitCode };
}

describe('src/server.ts — the real entrypoint, with real queued mail, makes no outbound connection of any kind', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    build();
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function freshDb(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-startup-test-'));
    dbPath = join(dir, 'shim.sqlite');
    // Tenant registration touches only the store, no network — safe setup
    // done directly rather than by spawning the CLI as a second process.
    const store = createSqliteStore(dbPath);
    store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY);
    store.close();
    return dbPath;
  }

  it('startup alone (nothing ever queued) stays silent — the baseline', async () => {
    const db = await freshDb();
    const port = await findFreePort();
    const result = await runServerLifecycle({ dbPath: db, port, liveForMs: 1500 });
    // Every one of these kinds (net.connect, dns.*, dgram.send,
    // child_process.*) is unexpected here, with no baseline to filter:
    // this is a spawned child, so the parent's own HTTP client traffic
    // against it never shows up as a connect() call FROM the child (the
    // server side of an accepted connection never calls Socket#connect at
    // all — only a client dialling out does), and the flow never needs
    // hostname resolution (127.0.0.1 is a literal), UDP, or a subprocess.
    expect(result.connectAttempts).toEqual([]);
  }, 20_000);

  it('a real message enqueued through the real HTTP API, then held alive for several seconds, still makes no outbound connection of any kind', async () => {
    const db = await freshDb();
    const port = await findFreePort();
    const result = await runServerLifecycle({ dbPath: db, port, enqueue: true, liveForMs: 3000 });
    expect(result.connectAttempts).toEqual([]);
  }, 20_000);
});

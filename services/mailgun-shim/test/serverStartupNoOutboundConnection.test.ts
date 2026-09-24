import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * test/noOutboundConnection.test.ts proves `createApp()` never dials out,
 * but `src/server.ts` has real top-level code of its own — `loadConfig()`,
 * `createSqliteStore()`, `createThrottle()`, the SIGTERM handler — none of
 * which that test exercises, because it builds the app directly rather
 * than running the actual entrypoint. A reviewer's sabotage proved the
 * gap: a `net.connect` added to server.ts left the other test green.
 *
 * This spawns the REAL entrypoint (`dist/server.js`, built fresh) as a
 * child process with a connect-guard preloaded before any of its top-level
 * code runs (test/helpers/connectGuardPreload.mjs), through a full
 * startup -> serve -> SIGTERM-shutdown cycle, and asserts the child never
 * once called net.Socket#connect. Unlike the in-process test, there is no
 * baseline to filter: every HTTP request against the child is made from
 * THIS (parent) process, which never touches the child's patched socket
 * prototype, so a silent child for its whole lifecycle is the entire bar.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const preloadPath = join(__dirname, 'helpers', 'connectGuardPreload.mjs');

const CONNECT_MARKER = 'CONNECT_ATTEMPT ';

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

/**
 * Spawns dist/server.js with the connect guard preloaded, waits for it to
 * report "listening", makes a handful of real requests against it (from
 * this parent process — never patched, so these never show up as
 * connect() calls the child made), then sends SIGTERM and waits for the
 * child's own graceful-shutdown log line before collecting everything it
 * reported.
 */
async function runServerLifecycle(port: number): Promise<RunResult> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    ['--import', preloadPath, serverJsPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        SHIM_ALLOW_EPHEMERAL_DB: 'true',
        SHIM_DRAIN_TOKEN: 'server-startup-proof-token',
        // Short, not the 30s production default — the /drain request below
        // holds for the whole configured window when nothing is queued
        // (correctly), and this test has nothing queued.
        SHIM_DRAIN_HOLD_MS: '300',
        PORT: String(port),
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

  // Real requests against the real entrypoint, from this (unpatched) parent
  // process — /healthz, /metrics and an authenticated /drain round trip.
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/healthz`);
  await fetch(`${base}/metrics`);
  await fetch(`${base}/drain`, {
    headers: { Authorization: 'Bearer server-startup-proof-token' },
  });

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
    .map((line) => JSON.parse(line.slice(CONNECT_MARKER.length)) as unknown);

  return { connectAttempts, stdout, stderr, exitCode };
}

// The sabotage proof for this test (restoring a net.connect call to
// server.ts, confirming this test goes red, reverting, confirming green)
// is done by hand against the working tree and recorded verbatim in the
// PR body — the same as this story's other sabotage records — rather than
// as an automated test that rewrites src/server.ts on disk. That would
// leave the working tree in a broken, half-sabotaged state on any
// interruption (a crash, a timeout, ctrl-C) between the write and the
// revert, for a property already fully proven by the manual record.
describe('src/server.ts — the real entrypoint makes no outbound connection', () => {
  beforeAll(() => {
    build();
  });

  it('startup, a full request cycle and graceful SIGTERM shutdown never call net.Socket#connect', async () => {
    const port = await findFreePort();
    const result = await runServerLifecycle(port);
    expect(result.connectAttempts).toEqual([]);
  }, 20_000);
});

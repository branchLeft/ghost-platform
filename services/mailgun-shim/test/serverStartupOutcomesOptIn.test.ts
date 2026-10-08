import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

/**
 * Runs the real compiled entrypoint and checks the outcome route's opt-in is
 * wired from the environment: absent unless SHIM_DRAIN_OUTCOMES is exactly
 * true. Unit tests of the router and of loadConfig cannot see a server.ts
 * that ignores the config. See serverStartupOutcomesOptIn.test.md.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const TOKEN = 'outcomes-opt-in-startup-proof-token';

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

async function withServer(
  extraEnv: Record<string, string>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-outcomes-optin-'));
  const port = await findFreePort();
  const smtpPort = await findFreePort();
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [serverJsPath],
    {
      cwd: projectRoot,
      // Deliberately not `...process.env`: ambient variables (including a
      // SHIM_DRAIN_OUTCOMES in the runner's shell) must not decide the result.
      env: {
        PATH: process.env.PATH ?? '',
        SHIM_DB_PATH: join(dir, 'shim.sqlite'),
        SHIM_DRAIN_TOKEN: TOKEN,
        PORT: String(port),
        SMTP_LISTEN_PORT: String(smtpPort),
        SMTP_LISTEN_HOST: '127.0.0.1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = (): void => {
        if (stdout.includes('"event":"listening"')) {
          resolve();
        } else if (child.exitCode !== null) {
          reject(new Error(`server exited early. stderr:\n${stderr}`));
        } else if (Date.now() > deadline) {
          reject(new Error(`never listened. stdout:\n${stdout}\nstderr:\n${stderr}`));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000)
      ),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function postOutcome(baseUrl: string, token: string | null): Promise<Response> {
  return fetch(`${baseUrl}/drain/outcomes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ outcomes: [{ id: 'x', drainCount: 1, outcome: 'delivered' }] }),
  });
}

describe('src/server.ts — the outcome route is opt-in from the environment', () => {
  it('with SHIM_DRAIN_OUTCOMES unset the route does not exist, even with the right token', async () => {
    await withServer({}, async (baseUrl) => {
      expect((await postOutcome(baseUrl, TOKEN)).status).toBe(404);
      // The rest of the drain contract is unaffected.
      const ack = await fetch(`${baseUrl}/drain/ack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ acks: [{ id: 'x', drainCount: 1 }] }),
      });
      expect(ack.status).toBe(200);
    });
  });

  it.each(['false', '1', 'TRUE'])(
    'with SHIM_DRAIN_OUTCOMES=%s the route still does not exist',
    async (value) => {
      await withServer({ SHIM_DRAIN_OUTCOMES: value }, async (baseUrl) => {
        expect((await postOutcome(baseUrl, TOKEN)).status).toBe(404);
      });
    }
  );

  it('with SHIM_DRAIN_OUTCOMES=true the route exists: 401 without the token, 200 with it', async () => {
    await withServer({ SHIM_DRAIN_OUTCOMES: 'true' }, async (baseUrl) => {
      expect((await postOutcome(baseUrl, null)).status).toBe(401);
      const ok = await postOutcome(baseUrl, TOKEN);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ recorded: [], alreadyHandled: [], unknown: ['x'] });
    });
  });
});

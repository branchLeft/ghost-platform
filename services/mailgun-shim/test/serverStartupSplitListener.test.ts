import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

/**
 * Runs the real compiled entrypoint and checks the drain handover is bound to
 * its own port when SHIM_DRAIN_PORT is set, and that the process refuses to
 * start when that port would be the mail API's. Unit tests of the two apps
 * cannot see a server.ts that mounts both on one listener. See
 * serverStartupSplitListener.test.md.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const TOKEN = 'split-listener-startup-proof-token';

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

interface Running {
  child: ChildProcessByStdio<null, Readable, Readable>;
  output(): { stdout: string; stderr: string };
  dir: string;
}

function start(env: Record<string, string>): Running {
  const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-split-listener-'));
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [serverJsPath],
    {
      cwd: projectRoot,
      // Deliberately not `...process.env`: an ambient SHIM_DRAIN_PORT in the
      // runner's shell must not decide the result.
      env: {
        PATH: process.env.PATH ?? '',
        SHIM_DB_PATH: join(dir, 'shim.sqlite'),
        SHIM_DRAIN_TOKEN: TOKEN,
        SMTP_LISTEN_HOST: '127.0.0.1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  return { child, output: () => ({ stdout, stderr }), dir };
}

async function stop({ child, dir }: Running): Promise<void> {
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  if (child.exitCode === null) child.kill('SIGTERM');
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

async function untilListening(running: Running, events: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { stdout, stderr } = running.output();
    if (events.every((e) => stdout.includes(`"event":"${e}"`))) return;
    if (running.child.exitCode !== null) {
      throw new Error(`server exited early. stderr:\n${stderr}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`never listened. stdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('src/server.ts — the drain handover is bound to its own port', () => {
  it('with SHIM_DRAIN_PORT set, /drain is served on the drain port and 404s on the mail API port', async () => {
    const port = await findFreePort();
    const drainPort = await findFreePort();
    const running = start({
      PORT: String(port),
      SHIM_DRAIN_PORT: String(drainPort),
      // An empty queue holds GET /drain open for the full hold.
      SHIM_DRAIN_HOLD_MS: '200',
      SMTP_LISTEN_PORT: String(await findFreePort()),
    });
    try {
      await untilListening(running, ['listening', 'drain_listening']);
      const auth = { Authorization: `Bearer ${TOKEN}` };

      const onMail = await fetch(`http://127.0.0.1:${port}/drain`, { headers: auth });
      expect(onMail.status).toBe(404);
      const ackOnMail = await fetch(`http://127.0.0.1:${port}/drain/ack`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ acks: [] }),
      });
      expect(ackOnMail.status).toBe(404);

      const onDrain = await fetch(`http://127.0.0.1:${drainPort}/drain`, {
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });
      expect(onDrain.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    } finally {
      await stop(running);
    }
  });

  it('with SHIM_DRAIN_PORT equal to PORT, the process exits non-zero and never listens', async () => {
    const port = await findFreePort();
    const running = start({
      PORT: String(port),
      SHIM_DRAIN_PORT: String(port),
      SMTP_LISTEN_PORT: String(await findFreePort()),
    });
    try {
      const code = await new Promise<number | null>((resolve) =>
        running.child.on('exit', (c) => resolve(c))
      );
      expect(code).not.toBe(0);
      const { stdout, stderr } = running.output();
      expect(stderr).toMatch(/SHIM_DRAIN_PORT/);
      expect(stdout).not.toContain('"event":"listening"');
    } finally {
      await stop(running);
    }
  });
});

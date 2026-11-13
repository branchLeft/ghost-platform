import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { complaintBody, send, sign, SECRET_A } from './helpers/harness.js';

// These start the compiled dist/server.js as its own process: Node's
// request-timeout sweep does not run inside the vitest worker.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'DRAIN_TOKEN_PLACEHOLDER_0123456789ABCDEF';

let dir: string;
let child: ChildProcess | undefined;
let webhookPort: number;
let drainPort: number;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function startProcess(extra: Record<string, string> = {}): Promise<void> {
  webhookPort = await freePort();
  drainPort = await freePort();
  writeFileSync(join(dir, 'secret'), SECRET_A.toString('base64'));
  writeFileSync(join(dir, 'token'), TOKEN);
  child = spawn(process.execPath, [join(projectRoot, 'dist', 'server.js')], {
    env: {
      PATH: process.env['PATH'] ?? '',
      WEBHOOK_HOST: '127.0.0.1',
      WEBHOOK_PORT: String(webhookPort),
      WEBHOOK_DRAIN_HOST: '127.0.0.1',
      WEBHOOK_DRAIN_PORT: String(drainPort),
      WEBHOOK_SECRET_FILE: join(dir, 'secret'),
      WEBHOOK_DRAIN_TOKEN_FILE: join(dir, 'token'),
      WEBHOOK_STATE_DIR: dir,
      WEBHOOK_HEADERS_TIMEOUT_MS: '300',
      WEBHOOK_REQUEST_TIMEOUT_MS: '400',
      WEBHOOK_CHECK_INTERVAL_MS: '50',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let seen = 0;
    child?.stdout?.on('data', (d: Buffer) => {
      seen += (String(d).match(/_listening/g) ?? []).length;
      if (seen >= 2) {
        resolve();
      }
    });
    child?.on('exit', (code) => reject(new Error(`server exited early with ${code}`)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sws-'));
});

afterEach(() => {
  child?.removeAllListeners('exit');
  child?.kill('SIGKILL');
  child = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function closeTimeOf(request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = connect(webhookPort, '127.0.0.1', () => socket.write(request));
    // An unread socket never reports the server's FIN, so drain it.
    socket.resume();
    socket.on('close', () => resolve(Date.now() - started));
    socket.on('error', () => undefined);
    setTimeout(() => {
      socket.destroy();
      reject(new Error('connection was never closed by the server'));
    }, 5000);
  });
}

describe('server process', () => {
  it('accepts a signed complaint and hands it over on the drain port', async () => {
    await startProcess();
    const body = complaintBody();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const reply = await send(webhookPort, 'POST', '/webhook', body, {
      'webhook-id': 'WEBHOOK_ID_PLACEHOLDER_1',
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${sign(SECRET_A, 'WEBHOOK_ID_PLACEHOLDER_1', timestamp, body)}`,
    });
    expect(reply.status).toBe(200);
    const drained = await send(drainPort, 'GET', '/drain', undefined, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(drained.status).toBe(200);
    expect(drained.body).toContain('SWG_UID_PLACEHOLDER_1');
    expect(drained.body).not.toContain('RECIPIENT_PLACEHOLDER');
  });

  it('does not serve the drain routes on the webhook port', async () => {
    await startProcess();
    const reply = await send(webhookPort, 'GET', '/drain', undefined, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reply.status).toBe(404);
  });

  it('refuses to start without a secret file', async () => {
    await expect(startProcess({ WEBHOOK_SECRET_FILE: join(dir, 'absent') })).rejects.toThrow(
      'exited early'
    );
  });

  it('closes a connection that stalls mid-body', async () => {
    await startProcess();
    const ms = await closeTimeOf(
      'POST /webhook HTTP/1.1\r\nHost: x\r\nContent-Length: 200\r\nwebhook-id: A\r\n\r\n{"event'
    );
    expect(ms).toBeLessThan(3000);
  });

  it('closes a connection that never finishes its headers', async () => {
    await startProcess();
    const ms = await closeTimeOf('POST /webhook HTTP/1.1\r\nHost: x\r\n');
    expect(ms).toBeLessThan(3000);
  });
});

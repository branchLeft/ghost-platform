import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeShimServer, type QueuedMessage } from '../helpers/fakeShimServer.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';
import { settle, until } from '../helpers/loopHarness.js';

/**
 * Starts the real compiled dist/server.js and watches what reaches the
 * stand-in for mx1. The loop's unit tests cannot see a server.ts that forgets
 * to switch the header From check on, or to hand the store its demo domain:
 * both have to be proven at the entrypoint.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const DRAIN_TOKEN = 'entrypoint-from-token';

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

const message = (id: string, from: string): QueuedMessage => ({
  id,
  domain: 'tenant-a.example',
  emailId: null,
  from,
  to: 'reader@example.com',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
  headers: {},
});

describe('dist/server.js -- the header From check is on and has a scope', () => {
  let dir: string;
  let shim: FakeShimServer;
  let sink: SmtpSink;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let logs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-from-'));
    logs = [];
    shim = new FakeShimServer(DRAIN_TOKEN);
    sink = await startSmtpSink('collector', 'sink-secret');
  });

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => child!.on('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      child = undefined;
    }
    await shim.close();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(descriptor: object, extraEnv: Record<string, string> = {}): Promise<void> {
    const shimUrl = await shim.listen();
    writeFileSync(
      join(dir, 'host.json'),
      JSON.stringify({ slug: 'host-a', appHostIp: '127.0.0.1', expiresAt: null, ...descriptor })
    );
    child = spawn(process.execPath, [serverJsPath], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(await findFreePort()),
        COLLECTOR_DESCRIPTOR_DIR: dir,
        COLLECTOR_SHIM_PORT: String(new URL(shimUrl).port),
        COLLECTOR_DRAIN_TOKEN: DRAIN_TOKEN,
        COLLECTOR_SMTP_HOST: '127.0.0.1',
        COLLECTOR_SMTP_PORT: String(sink.port),
        COLLECTOR_SMTP_USER: 'collector',
        COLLECTOR_SMTP_PASS: 'sink-secret',
        COLLECTOR_HEARTBEAT_URL: 'http://127.0.0.1:9/never-pinged',
        COLLECTOR_MESSAGES_PER_HOUR: '360000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => logs.push(chunk));
    child.stderr.resume();
  }

  const acked = (): string[] => shim.ackRequests.flat().map((ack) => ack.id);
  const fromsAtSink = (): Array<string | undefined> =>
    sink.messages.map((m) => m.parsed.from?.value[0]?.address);

  it("sends a tenant's in-scope From and refuses a forged one, both acked", async () => {
    shim.enqueue(message('forged', 'hello@main.example'));
    shim.enqueue(message('genuine', 'hello@tenant-a.example'));
    await start({
      kind: 'tenant',
      mail: { identity: { kind: 'tenant', domain: 'tenant-a.example', dkimSelector: 'sel' } },
    });
    await until(
      () => acked().includes('forged') && acked().includes('genuine'),
      'both acked',
      10_000
    );
    await settle();
    expect(fromsAtSink()).toEqual(['hello@tenant-a.example']);
  });

  it("holds a tenant's mail, unacked, when its descriptor names no sending domain", async () => {
    shim.enqueue(message('genuine', 'hello@tenant-a.example'));
    await start({ kind: 'tenant' });
    await until(() => logs.join('').includes('from-scope-unknown'), 'a hold', 10_000);
    await settle();
    expect(sink.messages).toEqual([]);
    expect(acked()).toEqual([]);
  });

  it("sends a demo's mail from the configured demo mail domain only", async () => {
    shim.enqueue(message('forged', 'hello@main.example'));
    shim.enqueue(message('genuine', 'hello@demo.example'));
    await start({ kind: 'demo' }, { COLLECTOR_DEMO_MAIL_DOMAIN: 'demo.example' });
    await until(
      () => acked().includes('forged') && acked().includes('genuine'),
      'both acked',
      10_000
    );
    await settle();
    expect(fromsAtSink()).toEqual(['hello@demo.example']);
  });

  it("holds a demo's mail when no demo mail domain is configured, and says so at start-up", async () => {
    shim.enqueue(message('genuine', 'hello@demo.example'));
    await start({ kind: 'demo' });
    await until(() => logs.join('').includes('from-scope-unknown'), 'a hold', 10_000);
    await settle();
    expect(logs.join('')).toContain('demo_mail_domain_not_set');
    expect(sink.messages).toEqual([]);
    expect(acked()).toEqual([]);
  });
});

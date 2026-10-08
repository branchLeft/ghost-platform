import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeOutcomeMessageId } from '../../src/outcomeId.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';

/**
 * Starts the real compiled dist/server.js with a clean environment and
 * watches what it actually submits to the stand-in delivery host. The unit
 * tests of loadConfig and of deliveryClient cannot see a server.ts that
 * ignores the configuration: the opt-in has to be proven at the entrypoint.
 * See ../../README.md#outcomes-carried-back-to-the-spool.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const DRAIN_TOKEN = 'entrypoint-opt-in-token';

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

describe('dist/server.js — outcomes are opt-in from the environment', () => {
  let dir: string;
  let shim: FakeShimServer;
  let sink: SmtpSink;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-optin-'));
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

  async function submitOneMessage(extraEnv: Record<string, string>) {
    const shimUrl = await shim.listen();
    writeFileSync(
      join(dir, 'tenant-a.json'),
      JSON.stringify({ kind: 'tenant', slug: 'tenant-a', appHostIp: '127.0.0.1', expiresAt: null })
    );
    shim.enqueue({
      id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    child = spawn(process.execPath, [serverJsPath], {
      cwd: projectRoot,
      // Deliberately not `...process.env`: an ambient COLLECTOR_OUTCOMES_*
      // in the runner's shell must not decide the result.
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
    child.stdout.resume();
    child.stderr.resume();
    const [received] = await sink.waitForCount(1, 10_000);
    return received!;
  }

  it('with the outcomes variables unset it requests no DSN, mints no correlation id and uses the From address as the return path', async () => {
    const received = await submitOneMessage({});
    expect(received.dsnNotify).toBeUndefined();
    expect(received.envelopeFrom).toBe('noreply@tenant-a.example');
    expect(decodeOutcomeMessageId(received.parsed.messageId ?? '')).toBeNull();
  });

  it('with both set it requests success, failure and delay notices to the return path, naming the message and spool', async () => {
    const received = await submitOneMessage({
      COLLECTOR_OUTCOMES_RETURN_PATH: 'outcomes@collector.example',
      COLLECTOR_OUTCOMES_DSN_DIR: dir,
    });
    expect(received.dsnNotify).toEqual(expect.arrayContaining(['SUCCESS', 'FAILURE', 'DELAY']));
    expect(received.envelopeFrom).toBe('outcomes@collector.example');
    expect(decodeOutcomeMessageId(received.parsed.messageId ?? '')).toMatchObject({
      targetId: 'tenant-a',
      id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844',
    });
  });
});

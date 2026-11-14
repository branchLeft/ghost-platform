import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { startFakeSweegoRelay, type FakeRelay } from '../helpers/fakeSweegoRelay.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';
import { until } from '../helpers/loopHarness.js';

/**
 * Starts the real compiled dist/server.js and watches where a newsletter for
 * a Sweego tenant actually goes. The account-wide cap has no default: with it
 * (or the counter file) unset, Sweego is treated as not configured and the
 * message goes through mx1. See ../../README.md#sweegousage-createsweegousage.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');
const DRAIN_TOKEN = 'entrypoint-cap-token';
const RELAY_USER = 'RELAY_USER_PLACEHOLDER';
const RELAY_PASS = 'relay-pass-entrypoint-placeholder';

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

describe('dist/server.js -- the Sweego account cap and counter file are required', () => {
  let dir: string;
  let shim: FakeShimServer;
  let sink: SmtpSink;
  let relay: FakeRelay;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let logs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-cap-'));
    logs = [];
    shim = new FakeShimServer(DRAIN_TOKEN);
    sink = await startSmtpSink('collector', 'sink-secret');
    relay = await startFakeSweegoRelay(RELAY_USER, RELAY_PASS);
    writeFileSync(join(dir, 'relay-credential'), RELAY_PASS, { mode: 0o600 });
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
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(extraEnv: Record<string, string>): Promise<void> {
    const shimUrl = await shim.listen();
    const descriptors = join(dir, 'descriptors');
    mkdirSync(descriptors);
    writeFileSync(
      join(descriptors, 'tenant-a.json'),
      JSON.stringify({
        kind: 'tenant',
        slug: 'tenant-a',
        appHostIp: '127.0.0.1',
        expiresAt: null,
        mail: {
          identity: { kind: 'tenant', domain: 'tenant-a.example', dkimSelector: 'sel' },
          route: { primary: 'sweego', sweegoAllowance: 5 },
        },
      })
    );
    shim.enqueue({
      id: '5dfbf575-9efc-4508-bc4f-e0f9314e4855',
      domain: 'tenant-a.example',
      emailId: 'email-1',
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    child = spawn(process.execPath, [serverJsPath], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(await findFreePort()),
        COLLECTOR_DESCRIPTOR_DIR: descriptors,
        COLLECTOR_SHIM_PORT: String(new URL(shimUrl).port),
        COLLECTOR_DRAIN_TOKEN: DRAIN_TOKEN,
        COLLECTOR_SMTP_HOST: '127.0.0.1',
        COLLECTOR_SMTP_PORT: String(sink.port),
        COLLECTOR_SMTP_USER: 'collector',
        COLLECTOR_SMTP_PASS: 'sink-secret',
        COLLECTOR_HEARTBEAT_URL: 'http://127.0.0.1:9/never-pinged',
        COLLECTOR_MESSAGES_PER_HOUR: '360000',
        COLLECTOR_SWEEGO_SMTP_HOST: '127.0.0.1',
        COLLECTOR_SWEEGO_SMTP_PORT: String(relay.port),
        COLLECTOR_SWEEGO_SMTP_USER: RELAY_USER,
        COLLECTOR_SWEEGO_SMTP_PASS_FILE: join(dir, 'relay-credential'),
        COLLECTOR_SWEEGO_MESSAGES_PER_HOUR: '360000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => logs.push(chunk));
    child.stderr.resume();
  }

  // The entrypoint's Sweego client insists on TLS, which the plain local
  // relay does not offer, so a newsletter that is routed to Sweego is tried,
  // fails and is held (bulk is never sent to mx1 on a Sweego failure). That
  // is the positive control: it shows the Sweego path is taken when the cap
  // and counter file are set, and not taken when either is missing.
  it('tries sweego, and holds the newsletter off mx1, when the cap and the counter file are set', async () => {
    await start({
      COLLECTOR_SWEEGO_ACCOUNT_CAP: '1000',
      COLLECTOR_SWEEGO_USAGE_STATE_PATH: join(dir, 'usage.json'),
    });
    await until(
      () => logs.join('').includes('sweego_submission_failed'),
      'a sweego attempt',
      10_000
    );
    expect(sink.messages).toEqual([]);
    expect(shim.ackRequests.flat()).toEqual([]);
    expect(logs.join('')).not.toContain('sweego_not_configured');
  });

  it('sends it through mx1 and never tries sweego when the account cap is unset', async () => {
    await start({ COLLECTOR_SWEEGO_USAGE_STATE_PATH: join(dir, 'usage.json') });
    await sink.waitForCount(1, 10_000);
    expect(logs.join('')).toContain('sweego_not_configured');
    expect(logs.join('')).not.toContain('sweego_submission_failed');
    expect(relay.accepted).toEqual([]);
  });

  it('sends it through mx1 and never tries sweego when the counter file is unset', async () => {
    await start({ COLLECTOR_SWEEGO_ACCOUNT_CAP: '1000' });
    await sink.waitForCount(1, 10_000);
    expect(logs.join('')).toContain('sweego_not_configured');
    expect(logs.join('')).not.toContain('sweego_submission_failed');
    expect(relay.accepted).toEqual([]);
  });
});

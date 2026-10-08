import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createDirectoryDsnMailbox } from '../../src/dsnMailbox.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createOutcomeRunner } from '../../src/outcomeRunner.js';
import { createThrottle } from '../../src/throttle.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';

const TOKEN = 'test-drain-token';

function bounceFor(messageId: string): string {
  return [
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx1.example.invalid',
    '',
    'Final-Recipient: rfc822; gone@example.com',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 no such user',
    '',
    '--B',
    'Content-Type: text/rfc822-headers',
    '',
    `Message-ID: ${messageId}`,
    '',
    '--B--',
    '',
  ].join('\r\n');
}

// The stand-in rig: a real SMTP sink accepts the submission (the "accepted"
// step), later a notification file appears (what mx1 would hand back), and a
// real HTTP spool double receives the outcome over the drain connection.
describe('outcome path, end to end through the real runtime', () => {
  let sink: SmtpSink;
  let shim: FakeShimServer;
  let baseUrl: string;
  let dir: string;

  beforeEach(async () => {
    sink = await startSmtpSink('collector', 'sink-secret');
    shim = new FakeShimServer(TOKEN);
    shim.outcomesEnabled = true;
    baseUrl = await shim.listen();
    dir = await mkdtemp(join(tmpdir(), 'outcome-path-'));
  });

  afterEach(async () => {
    await shim.close();
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts and acks first (reporting nothing), then reports the bounce for exactly that message and generation', async () => {
    shim.enqueue({
      id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'gone@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl }]);
    const drainClient = createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 });
    const deliveryClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
      outcomes: { returnPath: 'outcomes@collector.example' },
    });
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient,
      throttle: createThrottle({ messagesPerHour: 360_000 }),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
      outcomes: {
        runner: createOutcomeRunner({
          mailbox: createDirectoryDsnMailbox(dir),
          store,
          drainClient,
          log,
        }),
        intervalMs: 30,
      },
    });
    runtime.start();

    const [received] = await sink.waitForCount(1);
    // Accepted by the stand-in MTA and acked: no outcome has been reported.
    await new Promise((r) => setTimeout(r, 120));
    expect(shim.ackRequests).toHaveLength(1);
    expect(shim.outcomeRequests).toEqual([]);

    // mx1 later bounces it: the notification quotes the Message-ID the collector minted.
    await writeFile(join(dir, 'bounce.eml'), bounceFor(received!.parsed.messageId!));
    const deadline = Date.now() + 3000;
    while (shim.outcomeRequests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await runtime.stop();
    deliveryClient.close();

    expect(shim.outcomeRequests).toEqual([
      [
        {
          id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844',
          drainCount: shim.ackRequests[0]![0]!.drainCount,
          outcome: 'failed',
          severity: 'permanent',
          code: 550,
          message: 'smtp; 550 5.1.1 no such user',
        },
      ],
    ]);
    expect(await readdir(join(dir, 'processed'))).toEqual(['bounce.eml']);
  });

  it('without the opt-in the runtime never touches /drain/outcomes', async () => {
    shim.enqueue({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'r@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    await writeFile(join(dir, 'bounce.eml'), bounceFor('<x@y.invalid>'));
    const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl }]);
    const deliveryClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
    });
    const runtime = createCollectorRuntime({
      store,
      drainClient: createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient,
      throttle: createThrottle({ messagesPerHour: 360_000 }),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    await sink.waitForCount(1);
    await new Promise((r) => setTimeout(r, 150));
    await runtime.stop();
    deliveryClient.close();
    expect(shim.outcomeRequests).toEqual([]);
    expect(await readdir(dir)).toEqual(['bounce.eml']);
  });
});

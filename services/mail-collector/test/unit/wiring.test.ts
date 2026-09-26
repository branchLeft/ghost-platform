import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createDeliveredTracker } from '../../src/dedupe.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import { createDrainClient } from '../../src/drainClient.js';
import { DescriptorTargetStore } from '../../src/descriptorTargets.js';
import { createLogger } from '../../src/log.js';
import { createThrottle } from '../../src/throttle.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';

const DRAIN_TOKEN = 'estate-drain-token';

/**
 * Everything else in this directory either proves the real
 * DescriptorTargetStore reads only the descriptor (descriptorTargets.test.ts)
 * or proves the loop only ever drains what a TargetStore names
 * (collectorLoop.test.ts, against a plain test double). This file is the
 * one place both halves run together through the real construction path
 * server.ts uses -- a real DescriptorTargetStore reading real descriptor
 * files on disk, feeding the real collector loop -- so a break in the
 * WIRING between them (not just in either module's own logic) has
 * somewhere to show up.
 */
describe('end-to-end wiring: a real DescriptorTargetStore feeding the real collector loop', () => {
  let dir: string;
  let shimDescribed: FakeShimServer;
  let shimUndescribed: FakeShimServer;
  let sink: SmtpSink;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-wiring-'));
    shimDescribed = new FakeShimServer(DRAIN_TOKEN);
    shimUndescribed = new FakeShimServer(DRAIN_TOKEN);
    sink = await startSmtpSink('collector', 'sink-secret');
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all([shimDescribed.close(), shimUndescribed.close()]);
    await sink.close();
  });

  it('drains a descriptor-named host and never touches an undescribed one, even though both are reachable', async () => {
    const describedUrl = await shimDescribed.listen();
    // shimUndescribed is started (reachable on the network) but no
    // descriptor file for it is ever written to `dir` -- the wiring's own
    // version of the issue's sabotage control case.
    await shimUndescribed.listen();
    const shimPort = Number(new URL(describedUrl).port);

    writeFileSync(
      join(dir, 'tenant-a.json'),
      JSON.stringify({
        kind: 'tenant',
        slug: 'tenant-a',
        appHostIp: '127.0.0.1',
        expiresAt: null,
      })
    );

    shimDescribed.enqueue({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    shimUndescribed.enqueue({
      id: 'should-never-arrive',
      domain: 'undescribed.example',
      emailId: null,
      from: 'noreply@undescribed.example',
      to: 'reader@example.com',
      subject: 'Should never arrive',
      html: '<p>nope</p>',
      text: 'nope',
      headers: {},
    });

    const log = createLogger(() => {});
    const store = new DescriptorTargetStore({
      descriptorDir: dir,
      shimPort,
      maxStalenessMs: 60_000,
      log,
    });
    const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const deliveryClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
    });
    const throttle = createThrottle({ messagesPerHour: 360_000 });
    const dedupe = createDeliveredTracker(60_000);
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });

    await store.refresh(); // the real initial read server.ts performs before runtime.start()
    runtime.start();

    const received = await sink.waitForCount(1, 1000);
    expect(received[0]!.envelopeTo).toEqual(['reader@example.com']);

    await new Promise((r) => setTimeout(r, 300)); // give the undescribed host every chance anyway
    expect(sink.messages).toHaveLength(1);
    expect(shimUndescribed.drainRequests).toHaveLength(0);

    await runtime.stop();
    deliveryClient.close();
  });
});

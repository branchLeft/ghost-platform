import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createComplaintPuller } from '../../src/complaints/complaintPuller.js';
import { createReceiverClient } from '../../src/complaints/receiverClient.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createSentJournal, type SentJournal } from '../../src/sentJournal.js';
import { createSweegoDeliveryClient } from '../../src/sweegoDeliveryClient.js';
import { createThrottle } from '../../src/throttle.js';
import { FakeComplaintReceiver } from '../helpers/fakeComplaintReceiver.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import { startFakeSweegoRelay, type FakeRelay } from '../helpers/fakeSweegoRelay.js';
import {
  DRAIN_TOKEN,
  LOGIN,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  until,
} from '../helpers/loopHarness.js';

const RELAY_USER = 'RELAY_USER_PLACEHOLDER';
const RELAY_PASS = 'relay-pass-7c1e9d-placeholder';
const RECEIVER_TOKEN = 'receiver-drain-token-0123456789abcdef-placeholder';
const HEADER = 'x-branchleft-outcome';

/**
 * The whole path in one place: a drained message goes to a fake relay with its
 * correlation header and is written to the sent-id journal; a complaint the
 * fake receiver then holds is pulled, matched and reported to the spool it was
 * drained from, and only then released. Every hop is a real socket or file.
 */
describe('collector loop with the Sweego complaint path', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let dir: string;
  let relay: FakeRelay;
  let receiver: FakeComplaintReceiver;
  let journal: SentJournal;
  let stop: (() => Promise<void>) | undefined;
  let lines: string[];

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    shim.outcomesEnabled = true;
    baseUrl = await shim.listen();
    dir = mkdtempSync(join(tmpdir(), 'collector-complaint-loop-'));
    writeFileSync(join(dir, 'relay-credential'), RELAY_PASS, { mode: 0o600 });
    writeFileSync(join(dir, 'receiver-token'), `${RECEIVER_TOKEN}\n`, { mode: 0o600 });
    relay = await startFakeSweegoRelay(RELAY_USER, RELAY_PASS);
    receiver = new FakeComplaintReceiver(RECEIVER_TOKEN);
    lines = [];
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    await shim.close();
    await relay.close();
    await receiver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    const receiverUrl = await receiver.listen();
    const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'sweego' }]);
    const log = createLogger((line) => lines.push(line));
    const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    journal = createSentJournal({
      path: join(dir, 'state', 'sent.ndjson'),
      ttlMs: 35 * 24 * 60 * 60 * 1000,
    });
    const puller = createComplaintPuller({
      receiver: createReceiverClient({
        baseUrl: receiverUrl,
        tokenFile: join(dir, 'receiver-token'),
        timeoutMs: 2000,
      }),
      journal,
      store,
      outcomes: drainClient,
      log,
      options: {
        pollMs: 20,
        retryBackoffMs: 20,
        maxBackoffMs: 100,
        perTenantPerHour: 50,
        giveUpMs: 60_000,
      },
    });
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient: fakeClient(),
      sweegoDeliveryClient: createSweegoDeliveryClient({
        host: '127.0.0.1',
        port: relay.port,
        secure: false,
        user: RELAY_USER,
        passFile: join(dir, 'relay-credential'),
        timeoutMs: 5000,
        requireTls: false,
        outcomeHeader: HEADER,
      }),
      sweegoThrottle: countingThrottle(),
      sweegoQuota: QUOTA_FREE,
      sentJournal: journal,
      complaints: { puller, firstDelayMs: 20 },
      throttle: createThrottle({ messagesPerHour: 360_000 }),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
  }

  it('reports a complaint about a message it sent, to the spool it came from, then releases it', async () => {
    shim.enqueue(LOGIN('msg-1'));
    await start();
    await until(() => relay.accepted.length === 1, 'message sent');
    const carried = relay.accepted[0]!.headers.get(HEADER);
    expect(carried).toBe('msg-1.1');

    receiver.enqueue(String(carried));
    await until(() => shim.outcomeRequests.length === 1, 'complaint reported');
    expect(shim.outcomeRequests[0]).toEqual([
      { id: 'msg-1', drainCount: 1, outcome: 'complained' },
    ]);
    await until(() => receiver.queued.length === 0, 'complaint released');
    expect(receiver.ackRequests).toEqual([1]);
  });

  it('reports nothing for an id it never sent, and still releases it', async () => {
    shim.enqueue(LOGIN('msg-1'));
    await start();
    await until(() => relay.accepted.length === 1, 'message sent');

    receiver.enqueue('never-sent.1');
    receiver.enqueue('msg-1.2');
    await until(() => receiver.queued.length === 0, 'both released');
    expect(shim.outcomeRequests).toEqual([]);
    expect(lines.filter((l) => l.includes('complaint_unmatched'))).toHaveLength(2);
  });

  it('replaces a correlation header the message already carried, so an author cannot name another message', async () => {
    shim.enqueue({
      ...LOGIN('msg-1'),
      headers: { 'X-BranchLeft-Outcome': 'victim.1', 'X-Keep': 'y' },
    });
    await start();
    await until(() => relay.accepted.length === 1, 'message sent');
    const mail = relay.accepted[0]!;
    expect(mail.headers.get(HEADER)).toBe('msg-1.1');
    expect(mail.headerLines.filter((h) => h.key === HEADER)).toHaveLength(1);
    expect(mail.headers.get('x-keep')).toBe('y');

    receiver.enqueue('victim.1');
    await until(() => receiver.queued.length === 0, 'forgery released');
    expect(shim.outcomeRequests).toEqual([]);
  });

  it('keeps a complaint in the receiver while the spool refuses it, and reports it once the spool accepts', async () => {
    shim.enqueue(LOGIN('msg-1'));
    shim.outcomesEnabled = false;
    await start();
    await until(() => relay.accepted.length === 1, 'message sent');
    receiver.enqueue('msg-1.1');
    await until(() => lines.some((l) => l.includes('complaint_report_failed')), 'refusal seen');
    expect(receiver.queued).toHaveLength(1);
    expect(receiver.ackRequests).toEqual([]);

    shim.outcomesEnabled = true;
    await until(() => shim.outcomeRequests.length === 1, 'reported after the spool opted in');
    await until(() => receiver.queued.length === 0, 'released');
  });

  it('carries on sending when the journal cannot keep an entry', async () => {
    shim.enqueue(LOGIN('msg-1'));
    writeFileSync(join(dir, 'state'), 'a file where the journal directory should be');
    await start();
    await until(() => relay.accepted.length === 1, 'message sent anyway');
    await until(() => lines.some((l) => l.includes('sent_journal_not_recorded')), 'noted');
    await until(() => shim.ackRequests.flat().some((a) => a.id === 'msg-1'), 'message acked');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime, type CollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDemoCeilings } from '../../src/demoCeilings.js';
import {
  createDemoContainment,
  descriptorOwnerRecipients,
  type DemoContainment,
  type VerifiedRecipients,
} from '../../src/demoContainment.js';
import type { DeliveryClient } from '../../src/deliveryClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient, type WireMessage } from '../../src/drainClient.js';
import { createDroppedOutcomes } from '../../src/droppedOutcomes.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { FakeShimServer, type QueuedMessage } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import { DRAIN_TOKEN, countingThrottle, settle, until } from '../helpers/loopHarness.js';

/**
 * Demo mail is contained on the draining side, against local spools and a
 * stand-in delivery host: the slot's own sender, a verified recipient, and the
 * two ceilings. See ../../README.md#demo-mail-containment.
 */

const OWNER_A = 'prospect-a@example.com';
const OWNER_B = 'prospect-b@example.com';

const demoMessage = (id: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  domain: 'demo.example',
  emailId: null,
  from: 'admin@demo.example',
  to: OWNER_A,
  subject: `Subject ${id}`,
  html: `<p>${id}</p>`,
  text: id,
  headers: {},
  ...extra,
});

interface Delivered {
  id: string;
  from: string;
  to: string;
}

function recordingClient(): DeliveryClient & { readonly delivered: Delivered[]; failNext: number } {
  const client = {
    delivered: [] as Delivered[],
    failNext: 0,
    async deliver(message: WireMessage) {
      if (client.failNext > 0) {
        client.failNext -= 1;
        throw new Error('mx1 unavailable');
      }
      client.delivered.push({ id: message.id, from: message.from, to: message.to });
    },
    close() {},
  };
  return client;
}

describe('demo mail containment in the collector loop', () => {
  let shimA: FakeShimServer;
  let shimB: FakeShimServer;
  let urlA: string;
  let urlB: string;
  let runtime: CollectorRuntime | undefined;
  let logLines: string[];

  beforeEach(async () => {
    shimA = new FakeShimServer(DRAIN_TOKEN);
    shimB = new FakeShimServer(DRAIN_TOKEN);
    shimA.outcomesEnabled = true;
    shimB.outcomesEnabled = true;
    urlA = await shimA.listen();
    urlB = await shimB.listen();
    logLines = [];
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    await shimA.close();
    await shimB.close();
  });

  const slotA = (extra: Partial<DrainTarget> = {}): DrainTarget => ({
    id: 'slot-a',
    baseUrl: urlA,
    route: 'mx1',
    demo: true,
    sendingDomain: 'demo.example',
    senderLocalPart: 'slot-a-own',
    ownerEmail: OWNER_A,
    ...extra,
  });
  const slotB = (extra: Partial<DrainTarget> = {}): DrainTarget => ({
    id: 'slot-b',
    baseUrl: urlB,
    route: 'mx1',
    demo: true,
    sendingDomain: 'demo.example',
    senderLocalPart: 'slot-b-own',
    ownerEmail: OWNER_B,
    ...extra,
  });

  function start(options: {
    targets: DrainTarget[];
    containment?: DemoContainment | 'none';
    slotCeiling?: number;
    estateCeiling?: number;
    recipients?: VerifiedRecipients;
  }) {
    const mx1 = recordingClient();
    const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const log = createLogger((line) => logLines.push(line));
    const containment =
      options.containment === 'none'
        ? undefined
        : (options.containment ??
          createDemoContainment({
            recipients: options.recipients ?? descriptorOwnerRecipients,
            ceilings: createDemoCeilings({
              estateCeiling: options.estateCeiling ?? 1000,
              defaultSlotCeiling: options.slotCeiling ?? 1000,
              windowMs: 24 * 60 * 60 * 1000,
            }),
          }));
    runtime = createCollectorRuntime({
      store: createFakeTargetStore(options.targets),
      drainClient,
      droppedOutcomes: createDroppedOutcomes({ client: drainClient, log, retryMs: 30 }),
      deliveryClient: mx1,
      enforceHeaderFrom: true,
      ...(containment === undefined ? {} : { demoContainment: containment }),
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    return { mx1 };
  }

  const ackedA = (): string[] => shimA.ackRequests.flat().map((ack) => ack.id);
  const ackedB = (): string[] => shimB.ackRequests.flat().map((ack) => ack.id);
  const reportedA = (): Array<Record<string, unknown>> => shimA.outcomeRequests.flat();

  it('sends a slot as its own local part even when its Ghost asked for another on the demo domain', async () => {
    shimA.enqueue(demoMessage('m1', { from: 'admin@demo.example' }));
    shimA.enqueue(demoMessage('m2', { from: 'slot-b-own@demo.example' }));
    shimA.enqueue(demoMessage('m3', { from: 'Support <support@DEMO.example>' }));
    const { mx1 } = start({ targets: [slotA()] });
    await until(() => ackedA().length === 3, 'all acked');
    expect(mx1.delivered.map((d) => d.from)).toEqual([
      'slot-a-own@demo.example',
      'slot-a-own@demo.example',
      'slot-a-own@demo.example',
    ]);
  });

  it('still refuses a From outside the demo domain, as before', async () => {
    shimA.enqueue(demoMessage('forged', { from: 'ceo@main.example' }));
    const { mx1 } = start({ targets: [slotA()] });
    await until(() => ackedA().includes('forged'), 'acked');
    await settle();
    expect(mx1.delivered).toEqual([]);
    expect(reportedA()).toEqual([]);
  });

  it('does not let one slot exhausting its ceiling stop another slot', async () => {
    for (const id of ['a1', 'a2', 'a3']) {
      shimA.enqueue(demoMessage(id));
    }
    shimB.enqueue(demoMessage('b1', { to: OWNER_B }));
    const { mx1 } = start({ targets: [slotA(), slotB()], slotCeiling: 2 });
    await until(() => ackedA().length === 3 && ackedB().length === 1, 'all acked');
    await settle();
    expect(mx1.delivered.map((d) => d.id).sort()).toEqual(['a1', 'a2', 'b1']);
    // The refused one is recorded as failed on its own spool, not silently dropped.
    await until(() => reportedA().length === 1, 'the ceiling failure reported');
    expect(reportedA()[0]).toMatchObject({
      id: 'a3',
      outcome: 'failed',
      severity: 'temporary',
    });
    expect(logLines.join('\n')).toContain('slot-ceiling');
  });

  it("takes the slot ceiling from the slot's own descriptor over the collector default", async () => {
    shimA.enqueue(demoMessage('a1'));
    shimA.enqueue(demoMessage('a2'));
    const { mx1 } = start({ targets: [slotA({ mailCeiling: 1 })], slotCeiling: 50 });
    await until(() => ackedA().length === 2, 'both acked');
    expect(mx1.delivered.map((d) => d.id)).toEqual(['a1']);
  });

  it('stops every slot once the estate ceiling is reached', async () => {
    shimA.enqueue(demoMessage('a1'));
    shimA.enqueue(demoMessage('a2'));
    shimB.enqueue(demoMessage('b1', { to: OWNER_B }));
    shimB.enqueue(demoMessage('b2', { to: OWNER_B }));
    const { mx1 } = start({ targets: [slotA(), slotB()], estateCeiling: 3 });
    await until(() => ackedA().length === 2 && ackedB().length === 2, 'all acked');
    await settle();
    expect(mx1.delivered).toHaveLength(3);
    expect(logLines.join('\n')).toContain('estate-ceiling');
    // A later message on any slot, one that has sent nothing since, is refused too.
    shimA.enqueue(demoMessage('a3'));
    await until(() => ackedA().includes('a3'), 'a3 acked');
    expect(mx1.delivered).toHaveLength(3);
  });

  it('refuses a recipient outside the record, records it as failed on its spool, and sends nothing', async () => {
    shimA.enqueue(demoMessage('imported', { to: 'member@example.org' }));
    shimA.enqueue(demoMessage('own'));
    const { mx1 } = start({ targets: [slotA()] });
    await until(() => ackedA().length === 2, 'both acked');
    await until(() => reportedA().length === 1, 'the refusal reported');
    expect(mx1.delivered.map((d) => d.id)).toEqual(['own']);
    expect(reportedA()[0]).toMatchObject({
      id: 'imported',
      outcome: 'failed',
      severity: 'permanent',
    });
  });

  it('does not spend a place on a refused recipient', async () => {
    shimA.enqueue(demoMessage('x1', { to: 'member-1@example.org' }));
    shimA.enqueue(demoMessage('x2', { to: 'member-2@example.org' }));
    shimA.enqueue(demoMessage('own'));
    const { mx1 } = start({ targets: [slotA()], slotCeiling: 1 });
    await until(() => ackedA().length === 3, 'all acked');
    expect(mx1.delivered.map((d) => d.id)).toEqual(['own']);
  });

  it('reads the recipient record through its interface: a record that holds other addresses is obeyed', async () => {
    const record: VerifiedRecipients = {
      isVerified: (_slot, address) => address === 'verified-elsewhere@example.com',
    };
    shimA.enqueue(demoMessage('via-record', { to: 'verified-elsewhere@example.com' }));
    shimA.enqueue(demoMessage('descriptor-owner', { to: OWNER_A }));
    const { mx1 } = start({ targets: [slotA()], recipients: record });
    await until(() => ackedA().length === 2, 'both acked');
    expect(mx1.delivered.map((d) => d.id)).toEqual(['via-record']);
  });

  it('puts no address, subject or body in what it tells the spool or logs', async () => {
    shimA.enqueue(demoMessage('imported', { to: 'member@example.org' }));
    start({ targets: [slotA()] });
    await until(() => reportedA().length === 1, 'the refusal reported');
    const everything = JSON.stringify(reportedA()) + logLines.join('\n');
    expect(everything).not.toContain('member@example.org');
    expect(everything).not.toContain(OWNER_A);
    expect(everything).not.toContain('Subject imported');
  });

  it('does not spend a second place when mx1 fails and the message is offered again', async () => {
    shimA.enqueue(demoMessage('a1'));
    const mx1 = recordingClient();
    mx1.failNext = 1;
    const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const log = createLogger((line) => logLines.push(line));
    runtime = createCollectorRuntime({
      store: createFakeTargetStore([slotA()]),
      drainClient,
      deliveryClient: mx1,
      enforceHeaderFrom: true,
      demoContainment: createDemoContainment({
        recipients: descriptorOwnerRecipients,
        ceilings: createDemoCeilings({
          estateCeiling: 10,
          defaultSlotCeiling: 1,
          windowMs: 60_000,
        }),
      }),
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    await until(() => mx1.failNext === 0, 'the first attempt failed at mx1');
    // The shim's lease lapses and the same id is offered again.
    shimA.simulateLostAck();
    await until(() => mx1.delivered.length === 1, 'delivered on the second offer');
    expect(mx1.delivered[0]?.id).toBe('a1');
    expect(logLines.join('\n')).not.toContain('slot-ceiling');
  });

  it("holds a slot's mail, unsent and unacked, when it has no sender identity yet", async () => {
    shimA.enqueue(demoMessage('m1'));
    const { mx1 } = start({ targets: [slotA({ senderLocalPart: undefined })] });
    await until(() => logLines.join('\n').includes('identity-unknown'), 'a hold');
    await settle();
    expect(mx1.delivered).toEqual([]);
    expect(ackedA()).toEqual([]);
  });

  it("holds a demo's mail when the loop was built without a containment: never sent uncontained", async () => {
    shimA.enqueue(demoMessage('m1'));
    const { mx1 } = start({ targets: [slotA()], containment: 'none' });
    await until(() => logLines.join('\n').includes('demo_containment_missing'), 'a hold');
    await settle();
    expect(mx1.delivered).toEqual([]);
    expect(ackedA()).toEqual([]);
  });

  it("leaves a tenant's mail alone: its own sender, any recipient, no ceiling", async () => {
    shimA.enqueue({
      ...demoMessage('t1', { from: 'noreply@tenant-a.example', to: 'any-member@example.org' }),
    });
    shimA.enqueue({
      ...demoMessage('t2', { from: 'noreply@tenant-a.example', to: 'another-member@example.org' }),
    });
    const { mx1 } = start({
      targets: [
        {
          id: 'tenant-a',
          baseUrl: urlA,
          route: 'mx1',
          sendingDomain: 'tenant-a.example',
        },
      ],
      estateCeiling: 1,
      slotCeiling: 1,
    });
    await until(() => ackedA().length === 2, 'both acked');
    expect(mx1.delivered).toEqual([
      { id: 't1', from: 'noreply@tenant-a.example', to: 'any-member@example.org' },
      { id: 't2', from: 'noreply@tenant-a.example', to: 'another-member@example.org' },
    ]);
  });
});

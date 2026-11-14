import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createFailureCounter } from '../../src/submissionFailures.js';
import { FakeShimServer, type QueuedMessage } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  DRAIN_TOKEN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  settle,
  until,
} from '../helpers/loopHarness.js';

const SCOPE_A = 'tenant-a.example';
const SCOPE_B = 'tenant-b.example';
const MAIN = 'main.example';

const withFrom = (id: string, from: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  ...NEWSLETTER(id),
  from,
  ...extra,
});

describe('the header From check in the collector loop', () => {
  let shimA: FakeShimServer;
  let shimB: FakeShimServer;
  let urlA: string;
  let urlB: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    shimA = new FakeShimServer(DRAIN_TOKEN);
    shimB = new FakeShimServer(DRAIN_TOKEN);
    urlA = await shimA.listen();
    urlB = await shimB.listen();
    // A spool that has opted in to outcomes: a refused message must still
    // never be reported to it, because a permanent failure suppresses the recipient.
    shimA.outcomesEnabled = true;
    shimB.outcomesEnabled = true;
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    await shimA.close();
    await shimB.close();
  });

  function start(options: {
    targets: DrainTarget[];
    enforce?: boolean;
    withSweego?: boolean;
    dedupe?: ReturnType<typeof createSubmittedTracker>;
  }) {
    const mx1 = fakeClient();
    const sweego = fakeClient();
    const failures = createFailureCounter();
    const logLines: string[] = [];
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore(options.targets),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: mx1,
      ...(options.withSweego ? { sweegoDeliveryClient: sweego } : {}),
      sweegoThrottle: options.withSweego ? countingThrottle() : undefined,
      sweegoQuota: QUOTA_FREE,
      sweegoFailures: failures,
      ...(options.enforce === false ? {} : { enforceHeaderFrom: true }),
      throttle: countingThrottle(),
      dedupe: options.dedupe ?? createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger((line) => logLines.push(line)),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
    return { mx1, sweego, failures, logLines };
  }

  const ackedA = (): string[] => shimA.ackRequests.flat().map((ack) => ack.id);
  const ackedB = (): string[] => shimB.ackRequests.flat().map((ack) => ack.id);

  describe.each([
    ['mx1', 'mx1' as const],
    ['sweego', 'sweego' as const],
  ])('on the %s path', (_label, route) => {
    const target = (): DrainTarget => ({
      id: 'tenant-a',
      baseUrl: urlA,
      route,
      ...(route === 'sweego' ? { sweegoAllowance: 100 } : {}),
      sendingDomain: SCOPE_A,
    });
    const delivered = (run: ReturnType<typeof start>): string[] =>
      route === 'sweego' ? run.sweego.calls : run.mx1.calls;
    const other = (run: ReturnType<typeof start>): string[] =>
      route === 'sweego' ? run.mx1.calls : run.sweego.calls;

    it('delivers a message whose From is in scope', async () => {
      shimA.enqueue(withFrom('ok-1', `hello@${SCOPE_A}`));
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('ok-1'), 'acked');
      expect(delivered(run)).toEqual(['ok-1']);
      expect(run.failures.counts()).toEqual({});
    });

    it('refuses a From on the main domain even though nothing else about the message is odd', async () => {
      shimA.enqueue(withFrom('forged-1', `hello@${MAIN}`));
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('forged-1'), 'acked');
      await settle();
      expect(delivered(run)).toEqual([]);
      expect(other(run)).toEqual([]);
      expect(run.failures.counts()).toEqual({ 'from-out-of-scope': 1 });
    });

    it("refuses tenant B's address in tenant A's message, and delivers tenant B's own", async () => {
      shimA.enqueue(withFrom('cross-1', `hello@${SCOPE_B}`));
      shimB.enqueue(withFrom('own-1', `hello@${SCOPE_B}`));
      const run = start({
        targets: [
          target(),
          {
            id: 'tenant-b',
            baseUrl: urlB,
            route,
            ...(route === 'sweego' ? { sweegoAllowance: 100 } : {}),
            sendingDomain: SCOPE_B,
          },
        ],
        withSweego: true,
      });
      await until(() => ackedA().includes('cross-1') && ackedB().includes('own-1'), 'both acked');
      await settle();
      expect(delivered(run)).toEqual(['own-1']);
      expect(run.failures.counts()).toEqual({ 'from-out-of-scope': 1 });
    });

    it.each([
      [
        'a display name that names the scope',
        `"hello@${SCOPE_A}" <hello@${MAIN}>`,
        'from-out-of-scope',
      ],
      ['two addresses, one in scope', `hello@${SCOPE_A}, hello@${MAIN}`, 'from-unreadable'],
      ['two addresses, both in scope', `a@${SCOPE_A}, b@${SCOPE_A}`, 'from-unreadable'],
      ['an unparseable From', 'not an address at all', 'from-unreadable'],
      ['an empty From', '', 'from-unreadable'],
      ['a line break in the From', `hello@${SCOPE_A}\r\nBcc: x@${MAIN}`, 'from-unreadable'],
    ])('refuses %s', async (_what, from, reason) => {
      shimA.enqueue(withFrom('bad-1', from));
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('bad-1'), 'acked');
      await settle();
      expect(delivered(run)).toEqual([]);
      expect(other(run)).toEqual([]);
      expect(run.failures.counts()).toEqual({ [reason]: 1 });
    });

    it('refuses a message that has no From at all', async () => {
      const noFrom = withFrom('none-1', `hello@${SCOPE_A}`) as Partial<QueuedMessage>;
      delete noFrom.from;
      shimA.enqueue(noFrom as QueuedMessage);
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('none-1'), 'acked');
      await settle();
      expect(delivered(run)).toEqual([]);
      expect(run.failures.counts()).toEqual({ 'from-unreadable': 1 });
    });

    it('refuses a Sender header even when the From is in scope', async () => {
      shimA.enqueue(withFrom('sender-1', `hello@${SCOPE_A}`, { headers: { Sender: `x@${MAIN}` } }));
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('sender-1'), 'acked');
      await settle();
      expect(delivered(run)).toEqual([]);
      expect(run.failures.counts()).toEqual({ 'from-unreadable': 1 });
    });

    it('delivers a case and trailing-dot spelling of the in-scope domain', async () => {
      shimA.enqueue(withFrom('case-1', `Hello@TENANT-A.Example.`));
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('case-1'), 'acked');
      expect(delivered(run)).toEqual(['case-1']);
    });

    it('delivers an internationalised spelling of an in-scope domain', async () => {
      shimA.enqueue(withFrom('idn-1', 'hello@straße.example'));
      const run = start({
        targets: [{ ...target(), sendingDomain: 'xn--strae-oqa.example' }],
        withSweego: true,
      });
      await until(() => ackedA().includes('idn-1'), 'acked');
      expect(delivered(run)).toEqual(['idn-1']);
    });

    it('never tells the spool the recipient failed (a bounce would suppress an innocent address)', async () => {
      shimA.enqueue(withFrom('quiet-1', `hello@${MAIN}`));
      start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('quiet-1'), 'acked');
      await settle();
      expect(shimA.outcomeRequests).toEqual([]);
    });

    it('logs a reason and a message id, and nothing that names a host, recipient, subject or address', async () => {
      shimA.enqueue(
        withFrom('log-1', `"Secret Name" <leak@${MAIN}>`, {
          to: 'recipient-private@example.org',
          subject: 'Private subject line',
        })
      );
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('log-1'), 'acked');
      const refusals = run.logLines.filter((line) => line.includes('header_from_refused'));
      expect(refusals).toHaveLength(1);
      expect(JSON.parse(refusals[0]!)).toMatchObject({
        level: 'warn',
        event: 'header_from_refused',
        fields: { message: 'log-1', reason: 'from-out-of-scope' },
      });
      const all = run.logLines.join('\n');
      for (const secret of [
        'Secret Name',
        'leak',
        MAIN,
        'recipient-private',
        'Private subject',
        'tenant-a',
      ]) {
        expect(all).not.toContain(secret);
      }
    });

    it('re-acks, and never sends, a refused message the spool offers again after a lost ack', async () => {
      shimA.enqueue(withFrom('again-1', `hello@${MAIN}`));
      const run = start({ targets: [target()], withSweego: true });
      await until(() => ackedA().includes('again-1'), 'acked');
      shimA.enqueue(withFrom('again-1', `hello@${MAIN}`));
      await until(() => ackedA().filter((id) => id === 'again-1').length >= 2, 'acked again');
      expect(delivered(run)).toEqual([]);
      expect(run.failures.counts()).toEqual({ 'from-out-of-scope': 1 });
    });

    it('holds, and does not ack, a message whose host has no sending domain', async () => {
      shimA.enqueue(withFrom('held-1', `hello@${SCOPE_A}`));
      const { sendingDomain: _unused, ...unscoped } = target();
      void _unused;
      const run = start({ targets: [unscoped], withSweego: true });
      await until(() => run.failures.counts()['from-scope-unknown'] !== undefined, 'counted');
      await settle();
      expect(delivered(run)).toEqual([]);
      expect(other(run)).toEqual([]);
      expect(ackedA()).toEqual([]);
    });
  });

  it('is not applied by a runtime built without the switch, which is how every other test double is built', async () => {
    shimA.enqueue(withFrom('off-1', `hello@${MAIN}`));
    const run = start({
      targets: [{ id: 'tenant-a', baseUrl: urlA, route: 'mx1' }],
      enforce: false,
    });
    await until(() => ackedA().includes('off-1'), 'acked');
    expect(run.mx1.calls).toEqual(['off-1']);
  });
});

import { randomBytes } from 'node:crypto';
import type { Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { verifyOutcomeMessageId } from '../../src/outcomeId.js';
import { TargetSubmissionError, type SweegoQuota } from '../../src/sendingTarget.js';
import type { Throttle } from '../../src/throttle.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  DRAIN_TOKEN,
  LOGIN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  settle,
  until,
} from '../helpers/loopHarness.js';

/**
 * The lane return path is the envelope sender of every mx1 submission, so
 * Stalwart can choose the source IP by sender domain. This walks the whole
 * product: mail class x demo x route x outcome path on or off, through the
 * real collector loop and the real delivery client (only the SMTP transport
 * is replaced), and asserts what leaves for mx1. See
 * ../../README.md#lane-return-paths.
 */

const MESSAGE_ID_KEY = randomBytes(32).toString('hex');
const NL = 'bounce-nl@bounces-nl.example';
const TX = 'bounce-tx@bounces-tx.example';

type Route = 'mx1' | 'sweego-latched' | 'sweego-fallback';
const ROUTES: readonly Route[] = ['mx1', 'sweego-latched', 'sweego-fallback'];

interface Sent {
  envelope?: { from: string; to: string };
  dsn?: unknown;
  messageId?: string;
  from: string;
}

const NEVER_THROTTLED: Throttle = {
  tryTake: () => true,
  waitForToken: async () => {},
  empty() {},
  reload() {},
  currentRate: () => 0,
};

describe('lane return paths: every mx1 submission, by class and demo', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    await shim.close();
  });

  function run(options: {
    route: Route;
    demo: boolean;
    outcomes: boolean;
    lanes: boolean;
    sweegoFails?: boolean;
  }) {
    const sent: Sent[] = [];
    const mx1 = createDeliveryClient({
      host: 'mx1.invalid',
      port: 587,
      secure: false,
      user: 'collector',
      pass: 'unused',
      ...(options.lanes ? { lanes: { tx: TX, nl: NL } } : {}),
      ...(options.outcomes
        ? {
            outcomes: options.lanes
              ? { messageIdKey: MESSAGE_ID_KEY }
              : { returnPath: TX, messageIdKey: MESSAGE_ID_KEY },
          }
        : {}),
      transporterFactory: () =>
        ({
          sendMail: async (mail: Sent) => {
            sent.push(mail);
            return {};
          },
          close() {},
        }) as unknown as Transporter,
    });
    const sweego = fakeClient();
    if (options.sweegoFails) {
      sweego.behaviour = () => new TargetSubmissionError('refused', 'not-accepted');
    }
    const quota: SweegoQuota =
      options.route === 'sweego-latched'
        ? { allowanceReached: () => true, accountCapReached: () => false }
        : QUOTA_FREE;
    const target: DrainTarget = {
      id: 'tenant-a',
      baseUrl,
      route: options.route === 'mx1' ? 'mx1' : 'sweego',
      ...(options.demo ? { demo: true as const } : {}),
    };
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore([target]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: mx1,
      sweegoDeliveryClient: sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: quota,
      throttle: NEVER_THROTTLED,
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
    return { sent, sweego };
  }

  const cells = ROUTES.flatMap((route) =>
    [false, true].flatMap((demo) =>
      ['transactional', 'bulk'].flatMap((mailClass) =>
        [false, true].map((outcomes) => ({ route, demo, mailClass, outcomes }))
      )
    )
  );

  it.each(cells)(
    'route $route, demo $demo, $mailClass, outcomes $outcomes: the envelope sender is the lane path',
    async ({ route, demo, mailClass, outcomes }) => {
      const bulk = mailClass === 'bulk';
      // A newsletter cannot fall back from Sweego to mx1; it waits. A demo never
      // tries Sweego, so for a demo the fallback route reaches mx1 directly.
      const reachesMx1 = !(route === 'sweego-fallback' && bulk && !demo);
      shim.enqueue(bulk ? NEWSLETTER('m-1') : LOGIN('m-1'));
      const { sent } = run({
        route,
        demo,
        outcomes,
        lanes: true,
        sweegoFails: route === 'sweego-fallback',
      });
      if (!reachesMx1) {
        await settle();
        expect(sent).toEqual([]);
        return;
      }
      await until(() => sent.length === 1, 'one submission to mx1');
      const expected = bulk || demo ? NL : TX;
      expect(sent[0]!.envelope?.from).toBe(expected);
      // The correlation id and the DSN request follow the outcome path alone.
      expect(sent[0]!.dsn !== undefined).toBe(outcomes);
      if (!outcomes) {
        expect(sent[0]!.messageId).toBeUndefined();
        return;
      }
      expectSignedFor(sent[0]!.messageId, 'm-1');
    }
  );

  /**
   * The id must verify under the collector's key for the recipient it was sent
   * to, not merely have the right shape: a bounce is acted on only if it does.
   */
  function expectSignedFor(messageId: string | undefined, id: string): void {
    expect(messageId).toBeDefined();
    const recipient = `reader-${id}@example.com`;
    expect(verifyOutcomeMessageId(messageId!, [recipient], MESSAGE_ID_KEY)).toMatchObject({
      id,
      targetId: 'tenant-a',
    });
    // The same shape with one signature digit changed, another recipient's id,
    // or another key does not verify.
    const mac = /\.([0-9a-f]{32})@/.exec(messageId!)![1]!;
    const tampered = messageId!.replace(mac, `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`);
    expect(tampered).not.toBe(messageId);
    expect(verifyOutcomeMessageId(tampered, [recipient], MESSAGE_ID_KEY)).toBeNull();
    expect(verifyOutcomeMessageId(messageId!, ['other@example.com'], MESSAGE_ID_KEY)).toBeNull();
    expect(
      verifyOutcomeMessageId(messageId!, [recipient], randomBytes(32).toString('hex'))
    ).toBeNull();
  }

  it('leaves a message accepted by Sweego off mx1 altogether', async () => {
    shim.enqueue(NEWSLETTER('m-1'));
    shim.enqueue(LOGIN('m-2'));
    const { sent, sweego } = runFree();
    await until(() => sweego.calls.length === 2, 'both taken by Sweego');
    expect(sent).toEqual([]);
  });

  function runFree() {
    const sent: Sent[] = [];
    const sweego = fakeClient();
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'sweego' }]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: createDeliveryClient({
        host: 'mx1.invalid',
        port: 587,
        secure: false,
        user: 'collector',
        pass: 'unused',
        lanes: { tx: TX, nl: NL },
        transporterFactory: () =>
          ({
            sendMail: async (mail: Sent) => {
              sent.push(mail);
              return {};
            },
            close() {},
          }) as unknown as Transporter,
      }),
      sweegoDeliveryClient: sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: QUOTA_FREE,
      throttle: NEVER_THROTTLED,
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
    return { sent, sweego };
  }

  it.each(cells.filter((cell) => cell.route === 'mx1'))(
    'with no lane paths set the envelope is untouched: demo $demo, $mailClass, outcomes $outcomes',
    async ({ route, demo, mailClass, outcomes }) => {
      shim.enqueue(mailClass === 'bulk' ? NEWSLETTER('m-1') : LOGIN('m-1'));
      const { sent } = run({ route, demo, outcomes, lanes: false });
      await until(() => sent.length === 1, 'one submission to mx1');
      expect(sent[0]!.envelope?.from).toBe(outcomes ? TX : undefined);
    }
  );
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime, type CollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createIp2Lane, ip2State, type Ip2Lane } from '../../src/ip2Lane.js';
import { createLogger } from '../../src/log.js';
import { TargetSubmissionError, type SweegoQuota } from '../../src/sendingTarget.js';
import type { Throttle } from '../../src/throttle.js';
import { FakeShimServer, type QueuedMessage } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  ADMIT_ALL_DEMO_MAIL,
  DRAIN_TOKEN,
  LOGIN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  until,
} from '../helpers/loopHarness.js';

/**
 * The newsletter lane's caps and hold, through the real collector loop and
 * the real delivery client (only the SMTP transport is replaced). See
 * ../../README.md#ip2-newsletter-lane-ip2lanets.
 */

const NL = 'bounce-nl@bounces-nl.example';
const TX = 'bounce-tx@bounces-tx.example';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY1 = Date.parse('2026-11-19T12:00:00.000Z');

interface Sent {
  envelope?: { from: string; to: string };
  from: string;
  to: unknown;
}

const NEVER_THROTTLED: Throttle = {
  tryTake: () => true,
  waitForToken: async () => {},
  empty() {},
  reload() {},
  currentRate: () => 0,
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Route = 'mx1' | 'sweego-free' | 'sweego-latched' | 'sweego-fallback';

describe('the IP2 newsletter lane in the collector loop', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let dir: string;
  let statePath: string;
  let counterPath: string;
  let clock: number;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
    dir = mkdtempSync(join(tmpdir(), 'ip2-loop-'));
    statePath = join(dir, 'state.json');
    counterPath = join(dir, 'counter.json');
    clock = DAY1;
    writeState({ stage: 1, held: false, destinationHolds: [] });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) {
      await stop();
    }
    await shim.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeState(state: unknown): void {
    writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state));
  }

  function newLane(): Ip2Lane {
    return createIp2Lane({ statePath, counterPath, now: () => clock });
  }

  function start(options: {
    route?: Route;
    demo?: boolean;
    ip2?: Ip2Lane | undefined;
    /** An error the SMTP transport throws, instead of taking the message. */
    transportError?: Error;
  }): { sent: Sent[]; sweego: ReturnType<typeof fakeClient>; runtime: CollectorRuntime } {
    const route = options.route ?? 'mx1';
    const sent: Sent[] = [];
    const sweego = fakeClient();
    if (route === 'sweego-fallback') {
      sweego.behaviour = () => new TargetSubmissionError('refused', 'not-accepted');
    }
    const quota: SweegoQuota =
      route === 'sweego-latched'
        ? { allowanceReached: () => true, accountCapReached: () => false }
        : QUOTA_FREE;
    const target: DrainTarget = {
      id: 'tenant-a',
      baseUrl,
      route: route === 'mx1' ? 'mx1' : 'sweego',
      ...(options.demo ? { demo: true as const } : {}),
    };
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore([target]),
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
              if (options.transportError) {
                throw options.transportError;
              }
              sent.push(mail);
              return {};
            },
            close() {},
          }) as unknown as Transporter,
      }),
      sweegoDeliveryClient: sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: quota,
      demoContainment: ADMIT_ALL_DEMO_MAIL,
      throttle: NEVER_THROTTLED,
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
      ...(options.ip2 ? { ip2Lane: options.ip2 } : {}),
    });
    runtime.start();
    stops.push(() => runtime.stop());
    return { sent, sweego, runtime };
  }

  const toOf = (mail: Sent): string => String(mail.to);
  const to = (id: string, address: string, base: 'news' | 'login' = 'news'): QueuedMessage => ({
    ...(base === 'news' ? NEWSLETTER(id) : LOGIN(id)),
    to: address,
  });

  it('holds the 51st newsletter message of a stage-1 day, leaves it unacked, and sends it the next day', async () => {
    for (let i = 1; i <= 51; i += 1) {
      shim.enqueue(to(`m-${i}`, `r${i}@example.com`));
    }
    const { sent } = start({ ip2: newLane() });
    await until(() => sent.length === 50, 'fifty submissions');
    await pause(200);
    expect(sent).toHaveLength(50);
    expect(sent.every((mail) => mail.envelope?.from === NL)).toBe(true);
    expect(sent.map(toOf)).not.toContain('r51@example.com');
    expect(shim.ackRequests.flat().map((ack) => ack.id)).not.toContain('m-51');

    clock += DAY_MS;
    shim.simulateLostAck();
    await until(() => sent.length === 51, 'the held message goes the next day');
    expect(toOf(sent[50]!)).toBe('r51@example.com');
    expect(sent[50]!.envelope?.from).toBe(NL);
  });

  it('holds the 26th Gmail message of a stage-1 day while the 26th other-domain message goes', async () => {
    for (let i = 1; i <= 26; i += 1) {
      shim.enqueue(to(`g-${i}`, `g${i}@gmail.com`));
    }
    shim.enqueue(to('o-1', 'o1@example.com'));
    const { sent } = start({ ip2: newLane() });
    await until(() => sent.length === 26, 'twenty-five Gmail and one other');
    await pause(200);
    expect(sent.map(toOf)).not.toContain('g26@gmail.com');
    expect(sent.map(toOf)).toContain('o1@example.com');
    expect(sent.filter((mail) => toOf(mail).endsWith('@gmail.com'))).toHaveLength(25);
  });

  it('keeps the count across a restart in the same day', async () => {
    for (let i = 1; i <= 50; i += 1) {
      shim.enqueue(to(`m-${i}`, `r${i}@example.com`));
    }
    const first = start({ ip2: newLane() });
    await until(() => first.sent.length === 50, 'fifty submissions');
    await first.runtime.stop();

    shim.enqueue(to('m-51', 'r51@example.com'));
    const second = start({ ip2: newLane() });
    await pause(300);
    expect(second.sent).toEqual([]);
  });

  it('stops the newsletter lane when held, and not the sign-in lane', async () => {
    writeState({ stage: 1, held: true, destinationHolds: [] });
    shim.enqueue(to('n-1', 'a@example.com'));
    shim.enqueue(to('l-1', 'b@example.com', 'login'));
    const { sent } = start({ ip2: newLane() });
    await until(() => sent.length === 1, 'the sign-in message');
    await pause(200);
    expect(sent).toHaveLength(1);
    expect(toOf(sent[0]!)).toBe('b@example.com');
    expect(sent[0]!.envelope?.from).toBe(TX);
    expect(shim.ackRequests.flat().map((ack) => ack.id)).toEqual(['l-1']);
  });

  it('holds the newsletter lane only, on a corrupt state file', async () => {
    writeState('{ not json');
    shim.enqueue(to('n-1', 'a@example.com'));
    shim.enqueue(to('l-1', 'b@example.com', 'login'));
    const { sent } = start({ ip2: newLane() });
    await until(() => sent.length === 1, 'the sign-in message');
    await pause(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.envelope?.from).toBe(TX);
  });

  it('holds one destination group and sends the rest', async () => {
    writeState({ stage: 1, held: false, destinationHolds: ['yahoo'] });
    shim.enqueue(to('y-1', 'a@yahoo.com'));
    shim.enqueue(to('g-1', 'a@gmail.com'));
    const { sent } = start({ ip2: newLane() });
    await until(() => sent.length === 1, 'the Gmail message');
    await pause(200);
    expect(sent.map(toOf)).toEqual(['a@gmail.com']);
  });

  it('is off without a lane: the existing behaviour, every message goes', async () => {
    writeState('{ not json');
    for (let i = 1; i <= 60; i += 1) {
      shim.enqueue(to(`m-${i}`, `r${i}@example.com`));
    }
    const { sent } = start({});
    await until(() => sent.length === 60, 'all sixty');
  });

  it('never counts Sweego mail, and never holds it', async () => {
    writeState({ stage: 1, held: true, destinationHolds: [] });
    const lane = newLane();
    shim.enqueue(to('n-1', 'a@gmail.com'));
    const { sent, sweego } = start({ route: 'sweego-free', ip2: lane });
    await until(() => sweego.calls.length === 1, 'taken by Sweego');
    expect(sent).toEqual([]);
    expect(ip2State(lane).sentToday).toBe(0);
  });

  it('counts a newsletter that mx1 takes', async () => {
    const lane = newLane();
    shim.enqueue(to('n-1', 'a@example.com'));
    const { sent } = start({ ip2: lane });
    await until(() => sent.length === 1, 'one submission');
    expect(ip2State(lane).sentToday).toBe(1);
  });

  it('gives the place back when mx1 refuses before any message data', async () => {
    const lane = newLane();
    shim.enqueue(to('n-1', 'a@example.com'));
    start({
      ip2: lane,
      transportError: Object.assign(new Error('refused'), { command: 'RCPT TO' }),
    });
    await pause(300);
    expect(ip2State(lane).sentToday).toBe(0);
  });

  it('keeps the place when the submission may have been taken', async () => {
    const lane = newLane();
    shim.enqueue(to('n-1', 'a@example.com'));
    start({
      ip2: lane,
      transportError: Object.assign(new Error('timed out'), { command: 'DATA' }),
    });
    await pause(300);
    expect(ip2State(lane).sentToday).toBe(1);
  });

  describe('no held message ever leaves on the sign-in address or at Sweego', () => {
    const holds: Array<[string, () => void]> = [
      ['the lane held', () => writeState({ stage: 1, held: true, destinationHolds: [] })],
      [
        'the destination held',
        () => writeState({ stage: 1, held: false, destinationHolds: ['gmail'] }),
      ],
      ['an unreadable state file', () => writeState('{ not json')],
      [
        'the day full',
        () =>
          writeFileSync(
            counterPath,
            JSON.stringify({
              version: 1,
              day: '2026-11-19',
              total: 50,
              demo: 0,
              destinations: { gmail: 0, microsoft: 0, yahoo: 0 },
              ids: [],
            })
          ),
      ],
    ];
    const routes: Route[] = ['mx1', 'sweego-latched', 'sweego-fallback'];
    const cells = routes.flatMap((route) =>
      [false, true].flatMap((demo) =>
        [false, true].flatMap((bulk) =>
          holds.map(([name, apply]) => ({ route, demo, bulk, name, apply }))
        )
      )
    );

    it.each(cells)(
      'route $route, demo $demo, bulk $bulk, with $name',
      async ({ route, demo, bulk, apply }) => {
        const message = to('m-1', 'reader@gmail.com', bulk ? 'news' : 'login');

        // The same message with nothing held: where it goes, and by which address.
        shim.enqueue(message);
        const control = start({ route, demo, ip2: newLane() });
        await pause(250);
        const controlNl = control.sent.filter((mail) => mail.envelope?.from === NL);
        const controlTx = control.sent.filter((mail) => mail.envelope?.from === TX);
        await control.runtime.stop();
        // Only the sign-in address of a non-demo sign-in message is ever used for TX.
        expect(controlTx.length === 0 || (!bulk && !demo)).toBe(true);
        const onNewsletterLane = controlNl.length === 1;
        // Mail that rides the newsletter lane on mx1 is what the hold is for.
        expect(onNewsletterLane).toBe(
          (bulk || demo) && !(route === 'sweego-fallback' && bulk && !demo)
        );

        // Fresh spool and files, same message, now held.
        await shim.close();
        shim = new FakeShimServer(DRAIN_TOKEN);
        baseUrl = await shim.listen();
        rmSync(counterPath, { force: true });
        writeState({ stage: 1, held: false, destinationHolds: [] });
        apply();
        shim.enqueue(message);
        const held = start({ route, demo, ip2: newLane() });
        await pause(250);

        // Nothing leaves on the newsletter lane, nothing new on the sign-in address,
        // and Sweego is asked for no more than it was with nothing held.
        expect(held.sent.filter((mail) => mail.envelope?.from === NL)).toEqual([]);
        expect(held.sent.filter((mail) => mail.envelope?.from === TX)).toHaveLength(
          controlTx.length
        );
        expect(held.sweego.calls).toEqual(control.sweego.calls);
        if (onNewsletterLane) {
          expect(held.sent).toEqual([]);
          expect(shim.ackRequests.flat().map((ack) => ack.id)).not.toContain('m-1');
        }
      }
    );
  });
});

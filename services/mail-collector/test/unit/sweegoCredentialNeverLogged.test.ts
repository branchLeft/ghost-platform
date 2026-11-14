import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createFailureCounter } from '../../src/submissionFailures.js';
import { createSweegoDeliveryClient } from '../../src/sweegoDeliveryClient.js';
import { loadConfig } from '../../src/config.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  closedLoopbackPort,
  startFakeSweegoRelay,
  type FakeRelay,
  type RelayBehaviour,
} from '../helpers/fakeSweegoRelay.js';
import {
  DRAIN_TOKEN,
  LOGIN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  until,
} from '../helpers/loopHarness.js';

const RELAY_USER = 'RELAY_USER_PLACEHOLDER';
const RELAY_PASS = 'relay-pass-7c1e9d-placeholder';

// Every way a submission can end, the relay's refusal text echoing the
// address and the login it was handed.
const SCENARIOS: Array<[string, RelayBehaviour]> = [
  ['accepted', {}],
  ['login refused', { authReply: 535 }],
  ['a 4xx at MAIL', { mailFromReply: 451 }],
  ['a 5xx at MAIL', { mailFromReply: 550 }],
  ['a 4xx at RCPT', { rcptReply: 450 }],
  ['a 5xx at RCPT', { rcptReply: 550 }],
  ['a 5xx at the end of DATA', { dataReply: 554 }],
  ['a timeout after DATA', { hangAfterData: true }],
];

describe('the Sweego credential, recipient and subject are never emitted', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let dir: string;
  let relay: FakeRelay;

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
    dir = mkdtempSync(join(tmpdir(), 'collector-sweego-secret-'));
    writeFileSync(join(dir, 'relay-credential'), `${RELAY_PASS}\n`, { mode: 0o600 });
    relay = await startFakeSweegoRelay(RELAY_USER, RELAY_PASS);
  });

  afterEach(async () => {
    await shim.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function sweegoClient(options: { port?: number; passFile?: string } = {}) {
    return createSweegoDeliveryClient({
      host: '127.0.0.1',
      port: options.port ?? relay.port,
      secure: false,
      user: RELAY_USER,
      passFile: options.passFile ?? join(dir, 'relay-credential'),
      timeoutMs: 400,
      requireTls: false,
    });
  }

  it('finds none of them in any log line, exception message or counter the client emits', async () => {
    const emitted: string[] = [];
    const secrets: string[] = [RELAY_PASS, RELAY_USER];
    const failures = createFailureCounter();
    const logger = createLogger((line) => emitted.push(line));
    let sequence = 0;

    async function runLoop(
      port: number,
      passFile: string | undefined,
      build: typeof LOGIN
    ): Promise<void> {
      sequence += 1;
      const id = `zq${sequence}x`;
      const queued = build(id);
      secrets.push(queued.to, queued.subject, queued.from);
      shim.enqueue(queued);
      const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'sweego' }]);
      const runtime = createCollectorRuntime({
        store,
        drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
        deliveryClient: fakeClient(),
        sweegoDeliveryClient: sweegoClient({ port, passFile }),
        sweegoThrottle: countingThrottle(),
        sweegoQuota: QUOTA_FREE,
        sweegoFailures: failures,
        throttle: countingThrottle(),
        dedupe: createSubmittedTracker(60_000),
        health: createHealthState(),
        log: logger,
        descriptorRefreshMs: 50,
        drainRetryBackoffMs: 50,
        emptyPollBackoffMs: 20,
      });
      runtime.start();
      const before = emitted.length;
      await until(
        () =>
          emitted.slice(before).some((line) => line.includes('"event":"submitted"')) ||
          emitted.slice(before).some((line) => line.includes('sweego_submission_failed')),
        `scenario ${sequence} finished`
      );
      await runtime.stop();
      shim.simulateLostAck();
    }

    for (const [, behaviour] of SCENARIOS) {
      relay.behaviour = behaviour;
      await runLoop(relay.port, undefined, LOGIN);
      await runLoop(relay.port, undefined, NEWSLETTER);
    }
    relay.behaviour = {};
    await runLoop(await closedLoopbackPort(), undefined, LOGIN);
    await runLoop(relay.port, join(dir, 'absent-file'), LOGIN);

    // The client's own exceptions, caught directly.
    const messages: string[] = [];
    for (const [, behaviour] of SCENARIOS) {
      relay.behaviour = behaviour;
      sequence += 1;
      const queued = LOGIN(`zq${sequence}y`);
      secrets.push(queued.to, queued.subject, queued.from);
      await sweegoClient()
        .deliver({ ...queued, drainCount: 1 })
        .catch((error: Error) => {
          messages.push(error.message, error.stack ?? '', JSON.stringify(error));
        });
    }

    const everything = [...emitted, ...messages, JSON.stringify(failures.counts())].join('\n');
    expect(emitted.length).toBeGreaterThan(20);
    expect(messages.length).toBeGreaterThan(20);
    for (const secret of secrets) {
      expect(everything).not.toContain(secret);
    }
    // The control case: the relay really was handed each of them.
    expect(relay.logins.some((l) => l.pass === RELAY_PASS)).toBe(true);
    expect(failures.counts()).not.toEqual({});
  });

  it('is read from a file path only: config holds the path, and refuses the value', () => {
    const base = {
      COLLECTOR_DESCRIPTOR_DIR: '/var/descriptors',
      COLLECTOR_DRAIN_TOKEN: 'token',
      COLLECTOR_SMTP_HOST: 'mx1.example.internal',
      COLLECTOR_SMTP_USER: 'collector',
      COLLECTOR_SMTP_PASS: 'secret',
      COLLECTOR_HEARTBEAT_URL: 'https://heartbeat.example/ping',
      COLLECTOR_SWEEGO_SMTP_HOST: 'SWEEGO_RELAY_HOST',
      COLLECTOR_SWEEGO_SMTP_USER: RELAY_USER,
      COLLECTOR_SWEEGO_SMTP_PASS_FILE: '/etc/collector/sweego-credential',
      COLLECTOR_SWEEGO_MESSAGES_PER_HOUR: '100',
    };
    const config = loadConfig(base);
    expect(config.sweego?.passFile).toBe('/etc/collector/sweego-credential');
    expect(JSON.stringify(config)).not.toContain(RELAY_PASS);
    expect(() => loadConfig({ ...base, COLLECTOR_SWEEGO_SMTP_PASS: RELAY_PASS })).toThrow(
      /read from a file/
    );
  });
});

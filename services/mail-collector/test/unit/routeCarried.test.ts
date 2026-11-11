import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import { DescriptorTargetStore, type DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createThrottle } from '../../src/throttle.js';
import { FakeShimServer, type QueuedMessage } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';

const DRAIN_TOKEN = 'estate-drain-token';
const here = dirname(fileURLToPath(import.meta.url));
const COMMITTED_DESCRIPTORS = join(here, '..', '..', 'docker-proof', 'descriptors');

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'tenant',
    slug: 'tenant-a',
    appHostIp: '127.0.0.1',
    expiresAt: null,
    ...overrides,
  };
}

describe('the drain target carries the descriptor mail route', () => {
  let dir: string;
  const warnings: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-route-'));
    warnings.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function storeOver(directory: string): DescriptorTargetStore {
    return new DescriptorTargetStore({
      descriptorDir: directory,
      shimScheme: 'http',
      shimPort: 8080,
      maxStalenessMs: 60_000,
      log: createLogger((line) => warnings.push(line)),
    });
  }

  function write(name: string, body: unknown): void {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(body));
  }

  it('is mx1 for a descriptor that names no route, with or without a mail section', async () => {
    write('bare', descriptor({ slug: 'bare' }));
    write('mail-only', descriptor({ slug: 'mail-only', mail: { enabled: true } }));
    write('odd-mail', descriptor({ slug: 'odd-mail', mail: 'not-an-object' }));
    const store = storeOver(dir);
    await store.refresh();
    expect(store.targets.map((t) => [t.id, t.route]).sort()).toEqual([
      ['bare', 'mx1'],
      ['mail-only', 'mx1'],
      ['odd-mail', 'mx1'],
    ]);
  });

  it('is mx1 for every descriptor committed under docker-proof, which name no route', async () => {
    const files = readdirSync(COMMITTED_DESCRIPTORS).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const body = JSON.parse(readFileSync(join(COMMITTED_DESCRIPTORS, file), 'utf8')) as object;
      expect('mail' in body, file).toBe(false);
    }
    const store = storeOver(COMMITTED_DESCRIPTORS);
    await store.refresh();
    expect(store.targets).toHaveLength(files.length);
    expect(store.targets.map((t) => t.route)).toEqual(files.map(() => 'mx1'));
  });

  it('reads mx1 and sweego from mail.route.primary', async () => {
    write('a', descriptor({ slug: 'a', mail: { route: { primary: 'mx1' } } }));
    write('b', descriptor({ slug: 'b', mail: { route: { primary: 'sweego' } } }));
    const store = storeOver(dir);
    await store.refresh();
    const routes = Object.fromEntries(store.targets.map((t) => [t.id, t.route]));
    expect(routes).toEqual({ a: 'mx1', b: 'sweego' });
  });

  it('lets a demo name mx1 but refuses a demo that names sweego', async () => {
    write(
      'demo-ok',
      descriptor({ kind: 'demo', slug: 'demo-ok', mail: { route: { primary: 'mx1' } } })
    );
    write(
      'demo-bad',
      descriptor({ kind: 'demo', slug: 'demo-bad', mail: { route: { primary: 'sweego' } } })
    );
    const store = storeOver(dir);
    await store.refresh();
    expect(store.targets.map((t) => t.id)).toEqual(['demo-ok']);
  });

  it.each([
    ['an unknown target', { primary: 'mailgun' }],
    ['a differently cased target', { primary: 'MX1' }],
    ['a numeric target', { primary: 1 }],
    ['no target', {}],
    ['a fallback key beside a target', { primary: 'sweego', fallback: 'mx1' }],
    ['a bare string', 'sweego'],
    ['null', null],
    ['an array', ['sweego']],
  ])('treats a route that is %s as malformed: the host is not drained', async (_label, route) => {
    write('good', descriptor({ slug: 'good' }));
    write('bad', descriptor({ slug: 'bad', mail: { route } }));
    const store = storeOver(dir);
    await store.refresh();
    expect(store.targets.map((t) => t.id)).toEqual(['good']);
    expect(warnings.join('\n')).toContain('descriptor_malformed');
  });
});

describe('nothing reads the route: the drain output is byte-identical whatever it is', () => {
  const MESSAGES: QueuedMessage[] = ['m1', 'm2', 'm3'].map((id, index) => ({
    id,
    domain: 'tenant.example',
    emailId: index === 0 ? null : `email-${id}`,
    from: 'noreply@tenant.example',
    to: `reader-${id}@example.com`,
    toName: index === 1 ? 'Reader Two' : undefined,
    subject: `Subject ${id}`,
    html: `<p>${id}</p>`,
    text: id,
    headers: { 'List-Unsubscribe': `<https://tenant.example/unsubscribe/${id}>` },
  }));

  /** Runs one full drain-and-deliver pass and returns everything the collector emitted. */
  async function emittedFor(target: (baseUrl: string) => DrainTarget): Promise<string> {
    const shim = new FakeShimServer(DRAIN_TOKEN);
    const baseUrl = await shim.listen();
    for (const message of MESSAGES) shim.enqueue({ ...message });
    const sent: unknown[] = [];
    const stub = {
      sendMail: async (options: unknown) => {
        sent.push(options);
      },
      close: () => {},
    } as unknown as Transporter;
    const deliveryClient = createDeliveryClient({
      host: 'unused.invalid',
      port: 0,
      secure: false,
      user: 'unused',
      pass: 'unused',
      transporterFactory: () => stub,
    });
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore([target(baseUrl)]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
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
    const deadline = Date.now() + 5000;
    while (shim.ackRequests.flat().length < MESSAGES.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runtime.stop();
    deliveryClient.close();
    await shim.close();
    return JSON.stringify({ sent, acks: shim.ackRequests });
  }

  it('submits and acks exactly the same for mx1, for sweego, and for a target built before the field existed', async () => {
    const mx1 = await emittedFor((baseUrl) => ({ id: 'tenant-a', baseUrl, route: 'mx1' }));
    const sweego = await emittedFor((baseUrl) => ({ id: 'tenant-a', baseUrl, route: 'sweego' }));
    const before = await emittedFor(
      (baseUrl) => ({ id: 'tenant-a', baseUrl }) as unknown as DrainTarget
    );
    expect(JSON.parse(mx1).sent).toHaveLength(MESSAGES.length);
    expect(JSON.parse(mx1).acks.flat()).toHaveLength(MESSAGES.length);
    expect(sweego).toBe(mx1);
    expect(before).toBe(mx1);
  });
});

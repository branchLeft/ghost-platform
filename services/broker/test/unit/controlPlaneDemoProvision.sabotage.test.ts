/**
 * Each control case of the provisioning step is proven by sabotage: the same
 * scenario runs against a copy of the real module with one protection removed
 * (RED: the harm happens) and then against the real module (GREEN: it does
 * not).
 */
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type * as BrokerClient from '../../src/controlPlaneDemoBroker.js';
import type { DemoBroker } from '../../src/controlPlaneDemoBroker.js';
import type * as Provision from '../../src/controlPlaneDemoProvision.js';
import { descriptorForSlot } from '../helpers/fixtures.js';
import {
  DEMO_ID,
  SLOT,
  controllableHealth,
  countingGate,
  depsFor,
  fakeStore,
  recordingMailer,
  tunnelTo,
  virtualClock,
  type ControllableHealth,
} from '../helpers/demoProvisionRig.js';
import { cleanupSabotageTmp, importSabotaged } from '../helpers/sourceSabotage.js';
import { scripted } from '../helpers/scriptedBroker.js';
import { generateTestKeyPair } from '../helpers/signer.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
import * as realBroker from '../../src/controlPlaneDemoBroker.js';
import * as real from '../../src/controlPlaneDemoProvision.js';

let broker: TestBroker | undefined;
let health: ControllableHealth;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
});
afterAll(() => {
  cleanupSabotageTmp();
});

type Module = typeof Provision;

async function sabotaged(target: string, replacement: string): Promise<Module> {
  return importSabotaged<Module>('controlPlaneDemoProvision.ts', (source) => {
    if (!source.includes(target)) {
      throw new Error('sabotage target not found in controlPlaneDemoProvision.ts: update it');
    }
    return source.replace(target, replacement);
  });
}

type BrokerModule = typeof BrokerClient;

async function sabotagedBroker(target: string, replacement: string): Promise<BrokerModule> {
  return importSabotaged<BrokerModule>('controlPlaneDemoBroker.ts', (source) => {
    if (!source.includes(target)) {
      throw new Error('sabotage target not found in controlPlaneDemoBroker.ts: update it');
    }
    return source.replace(target, replacement);
  });
}

async function started(): Promise<TestBroker> {
  health = controllableHealth();
  broker = await startTestBroker({ wrapDeps: (deps) => ({ ...deps, healthChecker: health }) });
  return broker;
}

async function verbs(b: TestBroker): Promise<string[]> {
  const text = await readFile(b.wrapperLogPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as string[]).at(-1) as string);
}

async function phase(b: TestBroker): Promise<string> {
  const response = await fetch(`${b.baseUrl}/status/${SLOT}`);
  return ((await response.json()) as { phase: string }).phase;
}

describe('provisioning control cases: source-mutation sabotage', () => {
  it('success inferred from the reconcile answer: a Ghost that never answers healthy is called LIVE; the real module says FAILED', async () => {
    const mutated = await sabotaged(
      "const verdict = await pollUntilHealthy(deps, slot);\n  if (verdict !== 'healthy')",
      "const verdict: string = 'healthy';\n  if (verdict !== 'healthy')"
    );
    for (const [name, module, expected] of [
      ['RED', mutated, 'LIVE'],
      ['GREEN', real, 'FAILED'],
    ] as const) {
      const b = await started();
      health.script([false]);
      const clock = virtualClock();
      const deps = depsFor(fakeStore(clock.nowMs), tunnelTo(b), countingGate(), clock);
      const outcome = await module.provisionDemo(deps, DEMO_ID, SLOT);
      expect(outcome.state, name).toBe(expected);
      await broker?.close();
      broker = undefined;
    }
  });

  it('a lost answer is not sent again: the retry path starts a second demo on the host; the real module sends the same descriptor once more and starts one', async () => {
    const mutated = await sabotaged('sent < deps.resendLimit', 'sent < 0');
    for (const [name, module, expectedStarts] of [
      ['RED', mutated, 2],
      ['GREEN', real, 1],
    ] as const) {
      const b = await started();
      let dropped = 0;
      const lossy: typeof globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/reconcile') && dropped === 0) {
          dropped += 1;
          throw new DOMException('timed out', 'TimeoutError');
        }
        return response;
      };
      const clock = virtualClock();
      const deps = depsFor(
        fakeStore(clock.nowMs),
        tunnelTo(b, { fetch: lossy }),
        countingGate(),
        clock
      );
      await module.provisionDemo(deps, DEMO_ID, SLOT);
      expect(
        (await verbs(b)).filter((verb) => verb === 'start'),
        name
      ).toHaveLength(expectedStarts);
      await broker?.close();
      broker = undefined;
    }
  });

  it("a refusal treated as the worker's own slot: the occupant is reset away; the real module leaves it running", async () => {
    const mutated = await sabotaged(
      "return { ok: false, reason: 'refused', retryable: false, ours: false };",
      "return { ok: false, reason: 'refused', retryable: false, ours: true };"
    );
    for (const [name, module, expectedPhase] of [
      ['RED', mutated, 'free'],
      ['GREEN', real, 'running'],
    ] as const) {
      const b = await started();
      const occupant = descriptorForSlot(SLOT, {
        hostname: { kind: 'ours', sub: 'someone-elses-demo', gated: true },
        siteUrl: 'https://someone-elses-demo.demo-domain.example.test' as never,
      });
      expect(
        (await b.signedFetch('POST', '/reconcile', { slot: SLOT, descriptor: occupant })).status
      ).toBe(200);
      const clock = virtualClock();
      const deps = depsFor(fakeStore(clock.nowMs), tunnelTo(b), countingGate(), clock);
      await module.provisionDemo(deps, DEMO_ID, SLOT);
      expect(await phase(b), name).toBe(expectedPhase);
      await broker?.close();
      broker = undefined;
    }
  });

  // ---- Debt from the review of the demo provisioning step ----

  it('a reconcile that outlasts the call deadline: its resend meets the slot lock and is read as a refusal, FAILED with a running slot orphaned; the real client waits and goes LIVE', async () => {
    const mutated = await sabotagedBroker(
      "if (isLockedConflict(response.status, body)) return { kind: 'locked' };",
      '/* sabotage: the lock answer is read as a refusal */'
    );
    for (const [name, module, expectedState, expectedPhase, expectedStarts] of [
      ['RED', mutated, 'FAILED', 'running', 1],
      ['GREEN', realBroker, 'LIVE', 'running', 1],
    ] as const) {
      health = controllableHealth();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const b = await startTestBroker({
        wrapDeps: (deps) => ({
          ...deps,
          healthChecker: health,
          renderer: {
            render: async (descriptor) => {
              await held;
              return deps.renderer.render(descriptor);
            },
          },
        }),
      });
      broker = b;
      // The first reconcile is accepted by the host and is still running when the
      // client's deadline fires: the client sees no answer.
      let inFlight: Promise<unknown> | undefined;
      const deadlineFires: typeof globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/reconcile') && inFlight === undefined) {
          inFlight = fetch(input, init).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new DOMException('timed out', 'TimeoutError');
        }
        return fetch(input, init);
      };
      const tunnel: DemoBroker = module.createTunnelBroker({
        baseUrl: b.baseUrl,
        privateKeyRaw: b.keyPair.privateKeyRaw,
        nowSeconds: () => Math.floor(b.nowMs() / 1000),
        timeoutMs: 5000,
        fetch: deadlineFires,
      });
      const clock = virtualClock();
      const store = fakeStore(clock.nowMs);
      const deps = {
        ...depsFor(store, tunnel, countingGate(), clock),
        // Waiting is when the host's original reconcile finishes.
        sleep: async (ms: number) => {
          await clock.sleep(ms);
          release();
          await inFlight;
        },
      };
      const outcome = await real.provisionDemo(deps, DEMO_ID, SLOT);
      release();
      await inFlight;
      expect(outcome.state, name).toBe(expectedState);
      expect(await phase(b), name).toBe(expectedPhase);
      expect(
        (await verbs(b)).filter((verb) => verb === 'start'),
        name
      ).toHaveLength(expectedStarts);
      if (expectedState === 'LIVE') expect(await verbs(b), name).not.toContain('reset');
      await broker?.close();
      broker = undefined;
    }
  });

  it('a reset met by a lock gives up at once: the retry never happens; the real module waits and retries', async () => {
    const mutated = await sabotaged(
      "if (reply !== 'locked' || deps.nowMs() >= until) return reply;",
      'return reply;'
    );
    for (const [name, module, expected] of [
      ['RED', mutated, 'FAILED'],
      ['GREEN', real, 'LIVE'],
    ] as const) {
      const broker = scripted({
        reconcile: [{ kind: 'failed' }, { kind: 'running', colour: 'a' }],
        reset: ['locked', 'free'],
      });
      const clock = virtualClock();
      const outcome = await module.provisionDemo(
        depsFor(fakeStore(clock.nowMs), broker, countingGate(), clock),
        DEMO_ID,
        SLOT
      );
      expect(outcome.state, name).toBe(expected);
    }
  });

  it('the poll deadline removed: a status that is never readable is polled without end; the real module stops at the timeout', async () => {
    const mutated = await sabotaged(
      "if (deps.nowMs() >= deadline) return 'timeout';",
      "if (deps.nowMs() >= deadline && deps.nowMs() < 0) return 'timeout';"
    );
    for (const [name, module, expectedRunaway] of [
      ['RED', mutated, true],
      ['GREEN', real, false],
    ] as const) {
      let reads = 0;
      let ranAway = false;
      const stub: DemoBroker = {
        ...scripted(),
        // Unreadable until a runaway is declared, then an error phase so the test ends.
        status: async () => {
          reads += 1;
          if (reads > 500) {
            ranAway = true;
            return { phase: 'error', healthy: false };
          }
          return undefined;
        },
      };
      const clock = virtualClock();
      const outcome = await module.provisionDemo(
        depsFor(fakeStore(clock.nowMs), stub, countingGate(), clock),
        DEMO_ID,
        SLOT
      );
      expect(ranAway, name).toBe(expectedRunaway);
      if (!ranAway) expect(outcome, name).toMatchObject({ state: 'FAILED', reason: 'unhealthy' });
    }
  });

  it('the one-retry cap removed: a host that always fails is reset and tried again without end; the real module stops after the second attempt', async () => {
    const mutated = await sabotaged(
      'if (!result.ok && result.retryable) {',
      'while (!result.ok && result.retryable) {'
    );
    for (const [name, module, expectedSends] of [
      ['RED', mutated, 21],
      ['GREEN', real, 2],
    ] as const) {
      let sent = 0;
      const stub: DemoBroker = {
        ...scripted({ reset: ['free'] }),
        // Always fails; after 20 sends it refuses, only so a missing cap ends the test.
        reconcile: async () => {
          sent += 1;
          return sent > 20 ? { kind: 'refused', status: 409 } : { kind: 'failed' };
        },
      };
      const clock = virtualClock();
      await module.provisionDemo(
        depsFor(fakeStore(clock.nowMs), stub, countingGate(), clock),
        DEMO_ID,
        SLOT
      );
      expect(sent, name).toBe(expectedSends);
    }
  });

  it('FAILED written after the reset instead of before: the final reset runs while the demo is still PROVISIONING; the real module records FAILED first', async () => {
    const mutated = await sabotaged(
      `  await store.transition(demoId, 'FAILED');
  if (result.ours && !slotNeedsAttention && (await resetSlot(deps, slot)) !== 'free') {
    slotNeedsAttention = true;
  }`,
      `  if (result.ours && !slotNeedsAttention && (await resetSlot(deps, slot)) !== 'free') {
    slotNeedsAttention = true;
  }
  await store.transition(demoId, 'FAILED');`
    );
    for (const [name, module, expectedAtFinalReset] of [
      ['RED', mutated, 'PROVISIONING'],
      ['GREEN', real, 'FAILED'],
    ] as const) {
      const clock = virtualClock();
      const store = fakeStore(clock.nowMs);
      const inner = scripted({ reconcile: [{ kind: 'failed' }], reset: ['free'] });
      const stateAtReset: string[] = [];
      const stub: DemoBroker = {
        ...inner,
        reset: async (slot) => {
          stateAtReset.push(store.state());
          return inner.reset(slot);
        },
      };
      await module.provisionDemo(depsFor(store, stub, countingGate(), clock), DEMO_ID, SLOT);
      // Two resets: the retry's, then the final one.
      expect(stateAtReset, name).toHaveLength(2);
      expect(stateAtReset.at(-1), name).toBe(expectedAtFinalReset);
    }
  });

  it('a throw after PROVISIONING not caught: the demo is left PROVISIONING for the page to poll; the real module records FAILED', async () => {
    const mutated = await sabotaged(
      'return await failAfterThrow(deps, demoId, slot, label, progress.attempts, error);',
      'throw error;'
    );
    for (const [name, module, expectedState] of [
      ['RED', mutated, 'PROVISIONING'],
      ['GREEN', real, 'FAILED'],
    ] as const) {
      const clock = virtualClock();
      const store = fakeStore(clock.nowMs);
      const stub: DemoBroker = {
        ...scripted(),
        reconcile: async () => {
          throw new RangeError('a signing key of the wrong length');
        },
      };
      await module
        .provisionDemo(depsFor(store, stub, countingGate(), clock), DEMO_ID, SLOT)
        .catch(() => undefined);
      expect(store.state(), name).toBe(expectedState);
    }
  });

  it('a mail failure swallowed: the demo goes LIVE with a passphrase nobody was sent; the real module fails the attempt', async () => {
    const mutated = await sabotaged(
      'await deps.sendArrival({ address: ownerEmail, hostname: label, passphrase, expiresAt });',
      'await deps\n      .sendArrival({ address: ownerEmail, hostname: label, passphrase, expiresAt })\n      .catch(() => undefined);'
    );
    for (const [name, module, expectedState] of [
      ['RED', mutated, 'LIVE'],
      ['GREEN', real, 'FAILED'],
    ] as const) {
      const mailer = recordingMailer();
      mailer.fail = true;
      const clock = virtualClock();
      const outcome = await module.provisionDemo(
        depsFor(fakeStore(clock.nowMs), scripted(), countingGate(), clock, [], mailer.send),
        DEMO_ID,
        SLOT
      );
      expect(outcome.state, name).toBe(expectedState);
      expect(mailer.sent, name).toHaveLength(0);
    }
  });

  it('a slot that needs a person has its hostname retired: nothing keeps the slot from being offered again; the real module leaves the hostname unretired', async () => {
    const mutated = await sabotaged('if (slotNeedsAttention) {', 'if (false as boolean) {');
    for (const [name, module, expectedRetired] of [
      ['RED', mutated, 1],
      ['GREEN', real, 0],
    ] as const) {
      const clock = virtualClock();
      const store = fakeStore(clock.nowMs);
      const stub = scripted({ reconcile: [{ kind: 'failed' }], reset: ['free', 'unanswered'] });
      await module.provisionDemo(depsFor(store, stub, countingGate(), clock), DEMO_ID, SLOT);
      expect(store.retired, name).toHaveLength(expectedRetired);
    }
  });

  it('the tunnel address guard removed: a signed request goes to a public name; the real client refuses to be built', async () => {
    const mutated = await sabotagedBroker(
      "if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !local) {",
      'if (false as boolean) {'
    );
    for (const [name, module, expectedSends] of [
      ['RED', mutated, 1],
      ['GREEN', realBroker, 0],
    ] as const) {
      const sentTo: { url: string; signed: boolean }[] = [];
      const spy: typeof globalThis.fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        sentTo.push({ url: String(input), signed: headers.has('X-Broker-Signature') });
        return new Response('{}', { status: 500 });
      };
      try {
        const tunnel = module.createTunnelBroker({
          baseUrl: 'https://broker.example.com',
          privateKeyRaw: generateTestKeyPair().privateKeyRaw,
          fetch: spy,
        });
        await tunnel.reset(SLOT);
      } catch (error) {
        expect((error as Error).name, name).toBe('TunnelAddressError');
      }
      expect(sentTo, name).toHaveLength(expectedSends);
      if (expectedSends > 0) expect(sentTo[0], name).toMatchObject({ signed: true });
    }
  });
});

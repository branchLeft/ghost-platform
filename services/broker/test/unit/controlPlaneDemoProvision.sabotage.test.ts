/**
 * Each control case of the provisioning step is proven by sabotage: the same
 * scenario runs against a copy of the real module with one protection removed
 * (RED: the harm happens) and then against the real module (GREEN: it does
 * not).
 */
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type * as Provision from '../../src/controlPlaneDemoProvision.js';
import { descriptorForSlot } from '../helpers/fixtures.js';
import {
  DEMO_ID,
  SLOT,
  controllableHealth,
  countingGate,
  depsFor,
  fakeStore,
  tunnelTo,
  virtualClock,
  type ControllableHealth,
} from '../helpers/demoProvisionRig.js';
import { cleanupSabotageTmp, importSabotaged } from '../helpers/sourceSabotage.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
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
      "const verdict = await pollUntilHealthy(deps, slot);\n  if (verdict === 'healthy')",
      "const verdict: string = 'healthy';\n  if (verdict === 'healthy')"
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
});

// What a match does on the control plane's side: which tier, whether a slot
// dies, and in what order. The sabotage each rule is held by is named in
// matchAction.md.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import {
  actOnMatch,
  killDemoSlot,
  planMatch,
  tierOf,
  type Estate,
  type MatchVerdict,
} from '../../src/matchAction.js';
import { demoDescriptor } from '../helpers/fixtures.js';
import { tunnelTo } from '../helpers/demoProvisionRig.js';
import { scripted } from '../helpers/scriptedBroker.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const SLOT = '0' as SlotName;
const DEMO: Estate = { kind: 'demo', slot: SLOT };
const TENANT: Estate = { kind: 'tenant' };
const NOW = { sleep: async () => {}, delayMs: 0 };

const EXACT_CSAM: MatchVerdict = { classification: 'csam', matchType: 'exact' };
const NEAR_CSAM: MatchVerdict = { classification: 'csam', matchType: 'near' };
const HARMFUL: MatchVerdict = { classification: 'harmful-abusive-material', matchType: 'exact' };
const TEST: MatchVerdict = { classification: 'test' };

const TABLE: readonly [MatchVerdict | undefined, 'one' | 'two' | undefined][] = [
  [EXACT_CSAM, 'two'],
  [TEST, 'two'],
  [{ classification: 'test', matchType: 'near' }, 'two'],
  [NEAR_CSAM, 'one'],
  [{ classification: 'csam' }, 'one'],
  [{ classification: 'csam', matchType: null }, 'one'],
  [{ classification: 'csam', matchType: 'EXACT' }, 'one'],
  [{ classification: 'csam', matchType: ' exact' }, 'one'],
  [HARMFUL, 'one'],
  [{ classification: 'harmful-abusive-material', matchType: 'near' }, 'one'],
  [{ classification: 'harmful-abusive-material' }, 'one'],
  [{ classification: 'something-new', matchType: 'exact' }, 'one'],
  [{ classification: 'no-known-match' }, undefined],
  [{ classification: 'unavailable' }, undefined],
  [undefined, undefined],
];

describe('the tier of a verdict', () => {
  it.each(TABLE)('puts %j in tier %s', (verdict, tier) => {
    expect(tierOf(verdict)).toBe(tier);
  });

  it("agrees with the scanning adapter's policy on every row, so the host and the control plane never split", () => {
    const require = createRequire(import.meta.url);
    const adapter = require('../../../../adapters/scanning-storage/src/policy.js') as {
      tierOf: (v: MatchVerdict | undefined) => 'one' | 'two' | null;
    };
    for (const [verdict, tier] of TABLE) {
      expect(adapter.tierOf(verdict) ?? undefined, JSON.stringify(verdict)).toBe(tier);
    }
  });
});

describe('what each tier does on each estate', () => {
  it('tier two on a demo seals, starts the clock and kills the slot', () => {
    expect(planMatch(EXACT_CSAM, DEMO)).toEqual({
      tier: 'two',
      withhold: true,
      seal: true,
      startReportingClock: true,
      freeze: false,
      killSlot: true,
    });
  });

  it('tier two on a tenant seals and starts the clock, and does not take the site down', () => {
    expect(planMatch(EXACT_CSAM, TENANT)).toMatchObject({ seal: true, killSlot: false });
  });

  it('the test classification goes the whole way: it kills a demo as an exact match does', () => {
    expect(planMatch(TEST, DEMO)).toMatchObject({ tier: 'two', killSlot: true });
    expect(planMatch(TEST, TENANT)).toMatchObject({ tier: 'two', killSlot: false });
  });

  it.each([
    ['near + csam', NEAR_CSAM],
    ['harmful-abusive-material', HARMFUL],
  ])(
    'tier one (%s) freezes, identically on both estates, and never seals, reports or kills',
    (_name, verdict) => {
      for (const estate of [DEMO, TENANT]) {
        expect(planMatch(verdict, estate)).toEqual({
          tier: 'one',
          withhold: true,
          seal: false,
          startReportingClock: false,
          freeze: true,
          killSlot: false,
        });
      }
    }
  );

  it('a verdict that is not a match has no plan', () => {
    expect(planMatch({ classification: 'no-known-match' }, DEMO)).toBeUndefined();
  });
});

describe('killing a demo slot', () => {
  it('detaches the evidence first and resets only after the broker confirms it', async () => {
    const broker = scripted({ freeze: ['detached'], reset: ['free'] });
    expect(await killDemoSlot(broker, SLOT, NOW)).toEqual({ kind: 'killed' });
    expect(broker.order).toEqual(['freeze', 'reset']);
  });

  it('keeps asking while the detach is pending, then resets once it is confirmed', async () => {
    const broker = scripted({ freeze: ['pending', 'locked', 'unanswered', 'detached'] });
    expect(await killDemoSlot(broker, SLOT, NOW)).toEqual({ kind: 'killed' });
    expect(broker.order).toEqual(['freeze', 'freeze', 'freeze', 'freeze', 'reset']);
  });

  it.each(['pending', 'locked', 'unanswered', 'refused'] as const)(
    'never resets when the evidence is not confirmed detached (%s)',
    async (reply) => {
      const broker = scripted({ freeze: [reply] });
      expect(await killDemoSlot(broker, SLOT, { ...NOW, attempts: 3 })).toEqual({
        kind: 'evidence-not-detached',
        last: reply,
      });
      expect(broker.resets).toBe(0);
    }
  );

  it('does not retry a refusal, which is final', async () => {
    const broker = scripted({ freeze: ['refused'] });
    await killDemoSlot(broker, SLOT, NOW);
    expect(broker.freezes).toBe(1);
  });

  it('a slot that is already free holds nothing to kill and is not reset', async () => {
    const broker = scripted({ freeze: ['nothing-to-freeze'] });
    expect(await killDemoSlot(broker, SLOT, NOW)).toEqual({ kind: 'already-free' });
    expect(broker.resets).toBe(0);
  });

  it('retries a reset that is locked, and reports one that never completes without losing the evidence', async () => {
    const retried = scripted({ reset: ['locked', 'free'] });
    expect(await killDemoSlot(retried, SLOT, NOW)).toEqual({ kind: 'killed' });
    expect(retried.resets).toBe(2);

    const stuck = scripted({ reset: ['unanswered'] });
    expect(await killDemoSlot(stuck, SLOT, { ...NOW, attempts: 2 })).toEqual({
      kind: 'reset-failed',
      last: 'unanswered',
    });
    expect(stuck.freezes).toBe(1);
  });
});

describe('acting on a match', () => {
  it('a tier-two match on a demo kills the slot', async () => {
    const broker = scripted();
    const outcome = await actOnMatch(EXACT_CSAM, DEMO, broker, NOW);
    expect(outcome?.kill).toEqual({ kind: 'killed' });
    expect(broker.order).toEqual(['freeze', 'reset']);
  });

  it.each([
    ['a tier-two match on a tenant', EXACT_CSAM, TENANT],
    ['a tier-one match on a demo', NEAR_CSAM, DEMO],
    ['a tier-one match on a tenant', NEAR_CSAM, TENANT],
    ['any harmful-abusive-material on a demo', HARMFUL, DEMO],
  ])('%s never reaches a broker', async (_name, verdict, estate) => {
    const broker = scripted();
    const outcome = await actOnMatch(verdict, estate, broker, NOW);
    expect(outcome?.kill).toBeUndefined();
    expect(broker.order).toEqual([]);
  });

  it('a verdict that is not a match is nothing', async () => {
    const broker = scripted();
    expect(
      await actOnMatch({ classification: 'no-known-match' }, DEMO, broker, NOW)
    ).toBeUndefined();
    expect(broker.order).toEqual([]);
  });
});

describe('against the real broker', () => {
  let broker: TestBroker | undefined;
  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function verbs(b: TestBroker): Promise<string[]> {
    return (await readFile(b.wrapperLogPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as string[]).join(' '));
  }

  async function running(): Promise<TestBroker> {
    const b = await startTestBroker();
    broker = b;
    const reconcile = await b.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor(),
    });
    expect(reconcile.status).toBe(200);
    return b;
  }

  it('a tier-two match on a running demo detaches the evidence, then resets, and the slot is free', async () => {
    const b = await running();
    const tunnel = tunnelTo(b);

    const outcome = await actOnMatch(EXACT_CSAM, DEMO, tunnel, NOW);

    expect(outcome?.kill).toEqual({ kind: 'killed' });
    const sent = await verbs(b);
    expect(sent.indexOf('0 detach')).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('0 detach')).toBeLessThan(sent.indexOf('0 reset'));
    expect(await tunnel.status(SLOT)).toMatchObject({ phase: 'free' });
  });

  it('the same match with the detach failing leaves the slot up and sends no reset', async () => {
    const b = await startTestBroker({
      wrapDeps: (deps) => ({
        ...deps,
        wrapper: {
          ...deps.wrapper,
          detach: async () => {
            throw new Error('the held area is full');
          },
        },
      }),
    });
    broker = b;
    await b.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
    const tunnel = tunnelTo(b);

    const outcome = await actOnMatch(EXACT_CSAM, DEMO, tunnel, { ...NOW, attempts: 2 });

    expect(outcome?.kill).toMatchObject({ kind: 'evidence-not-detached', last: 'pending' });
    expect((await verbs(b)).filter((v) => v === '0 reset')).toEqual([]);
    expect(await tunnel.status(SLOT)).toMatchObject({ phase: 'detaching' });
  });

  it('a tier-one match on a running demo leaves it running and sends the broker nothing', async () => {
    const b = await running();
    const tunnel = tunnelTo(b);
    const before = await verbs(b);

    await actOnMatch(NEAR_CSAM, DEMO, tunnel, NOW);

    expect(await verbs(b)).toEqual(before);
    expect(await tunnel.status(SLOT)).toMatchObject({ phase: 'running' });
  });
});

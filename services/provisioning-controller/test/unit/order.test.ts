import { describe, expect, it } from 'vitest';
import { PlanOrderError, planOnboarding, type PlannedStep } from '../../src/index.js';
import { orderSteps } from '../../src/order.js';
import { completedDigests } from '../../src/state.js';
import { APPROVAL, World } from '../support/doubles.js';

const step = (id: string, dependsOn: string[] = []): PlannedStep =>
  ({ id, key: `T/${id}`, dependsOn }) as unknown as PlannedStep;

describe('orderSteps', () => {
  it('keeps the planner order when it already respects dependencies', async () => {
    const plan = await planOnboarding(APPROVAL.approvalId, new World().ports());
    expect(orderSteps(plan.steps).map((s) => s.id)).toEqual(plan.steps.map((s) => s.id));
  });

  it('moves a step after the steps it depends on', () => {
    const out = orderSteps([step('c', ['b']), step('a'), step('b', ['a'])]);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a cycle', () => {
    expect(() => orderSteps([step('a', ['b']), step('b', ['a'])])).toThrow(PlanOrderError);
  });

  it('refuses an unknown dependency and a repeated step', () => {
    const err = (() => {
      try {
        orderSteps([step('a', ['zz']), step('a')]);
      } catch (e) {
        return e as PlanOrderError;
      }
      return undefined;
    })();
    expect(err?.problems).toEqual(['repeated step a', 'a depends on unknown zz']);
  });
});

describe('completedDigests', () => {
  it('counts only complete records, and the last one wins', () => {
    const at = 'A';
    const approvalId = 'B';
    const done = completedDigests([
      { at, approvalId, event: 'started', key: 'k1', inputDigest: 'd1' },
      { at, approvalId, event: 'complete', key: 'k2', inputDigest: 'd2' },
      { at, approvalId, event: 'complete', key: 'k2', inputDigest: 'd3' },
      { at, approvalId, event: 'step-failed', key: 'k4', inputDigest: 'd4' },
      { at, approvalId, event: 'run-complete' },
      { at, approvalId, event: 'complete' },
    ]);
    expect([...done]).toEqual([['k2', 'd3']]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  executeOnboarding,
  planOnboarding,
  type EntryPoint,
  type PlannedStep,
  type StepId,
} from '../../src/index.js';
import { APPROVAL, World } from '../support/doubles.js';

/**
 * A fresh tenant Ghost has no owner, and its setup route makes whoever calls
 * it first the owner. The owner is therefore created from the app host before
 * the site is reachable, which is the edge's publishing step: nothing may put
 * a tenant's hostname at the edge until the owner account is complete.
 */

const stepsOf = async (world: World): Promise<readonly PlannedStep[]> =>
  (await planOnboarding(APPROVAL.approvalId, world.ports())).steps;

/** Every step `id` waits for, directly or through another step. */
function ancestors(steps: readonly PlannedStep[], id: StepId): Set<StepId> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<StepId>();
  const walk = (current: StepId): void => {
    for (const dep of byId.get(current)?.dependsOn ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        walk(dep);
      }
    }
  };
  walk(id);
  return seen;
}

const REACHES_THE_SITE: readonly EntryPoint[] = ['edge'];

describe('the owner account exists before the site is reachable', () => {
  it('plans create-owner-account as a dependency of every step that publishes at the edge', async () => {
    const steps = await stepsOf(new World());
    const publishing = steps.filter((s) => REACHES_THE_SITE.includes(s.entryPoint));
    expect(publishing.map((s) => s.id)).toEqual(['publish-hostnames']);
    for (const step of publishing) {
      expect(ancestors(steps, step.id).has('create-owner-account'), step.id).toBe(true);
    }
  });

  it('plans the edge after the owner step, so no step before the owner can wait on the edge', async () => {
    const steps = await stepsOf(new World());
    const owner = steps.find((s) => s.id === 'create-owner-account');
    expect(owner).toBeDefined();
    for (const step of steps.filter((s) => REACHES_THE_SITE.includes(s.entryPoint))) {
      expect(step.order, step.id).toBeGreaterThan(owner?.order ?? Infinity);
    }
    for (const step of steps) {
      if (step.order <= (owner?.order ?? 0)) {
        for (const edge of steps.filter((s) => REACHES_THE_SITE.includes(s.entryPoint))) {
          expect(ancestors(steps, step.id).has(edge.id), step.id).toBe(false);
        }
      }
    }
  });

  it('runs the owner account step on the app host after the first deploy', async () => {
    const steps = await stepsOf(new World());
    const owner = steps.find((s) => s.id === 'create-owner-account');
    expect(owner?.entryPoint).toBe('app-host');
    expect(owner?.dependsOn).toEqual(['first-deploy']);
  });

  it('has the owner account recorded complete when the edge is first asked to publish', async () => {
    const world = new World();
    const completeWhenEdgeCalled: string[][] = [];
    world.beforeCall = (request) => {
      if (request.id === 'publish-hostnames') {
        completeWhenEdgeCalled.push(world.state.completeKeys());
      }
    };
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.status).toBe('complete');
    expect(completeWhenEdgeCalled).toHaveLength(1);
    expect(completeWhenEdgeCalled[0]).toContain('TENANT_ID_PLACEHOLDER/create-owner-account');
    expect(completeWhenEdgeCalled[0]).toContain('TENANT_ID_PLACEHOLDER/first-deploy');
  });

  it('does not publish the hostname when the owner account step fails, so the claim route is never exposed', async () => {
    const world = new World();
    world.failAlways.add('TENANT_ID_PLACEHOLDER/create-owner-account');
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.status).toBe('stopped');
    expect(result.stoppedAt?.key).toBe('TENANT_ID_PLACEHOLDER/create-owner-account');
    const called = world.calls.map((c) => c.request.id);
    expect(called).toContain('first-deploy');
    expect(called).not.toContain('publish-hostnames');
  });

  it('does not publish the hostname when the owner step was refused as permanent', async () => {
    const world = new World();
    world.permanent.add('TENANT_ID_PLACEHOLDER/create-owner-account');
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.status).toBe('stopped');
    expect(world.calls.map((c) => c.request.id)).not.toContain('publish-hostnames');
  });
});

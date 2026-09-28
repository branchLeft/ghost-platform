import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { defineSchedulingDisabled } = require('../../ghost-adapter/scheduling-disabled.js') as {
  defineSchedulingDisabled: (base: new () => object) => new () => Record<string, unknown>;
};

/** Stands in for Ghost's SchedulingBase: the same requiredFns contract. */
class FakeSchedulingBase {
  readonly requiredFns = ['run', 'schedule', 'unschedule'];
  registered: unknown[] = [];
  register(rescheduler: unknown): void {
    this.registered.push(rescheduler);
  }
}

describe('SchedulingDisabled', () => {
  const Adapter = defineSchedulingDisabled(FakeSchedulingBase);
  const adapter = new Adapter() as unknown as FakeSchedulingBase & {
    rescheduleOnBoot: boolean;
    run(): unknown;
    schedule(job: unknown): unknown;
    unschedule(job: unknown): unknown;
    rescheduleAll(): Promise<unknown[]>;
  };

  it("is an instance of the base Ghost hands it, so Ghost's adapter manager accepts it", () => {
    expect(adapter).toBeInstanceOf(FakeSchedulingBase);
    for (const fn of adapter.requiredFns) {
      expect(typeof (adapter as unknown as Record<string, unknown>)[fn]).toBe('function');
    }
  });

  it('tells Ghost not to reschedule anything on boot', () => {
    expect(adapter.rescheduleOnBoot).toBe(false);
  });

  it('accepts every job and runs none of them', async () => {
    const job = {
      url: 'http://127.0.0.1:2368/ghost/api/admin/schedules/posts/x/',
      time: Date.now(),
    };
    expect(adapter.run()).toBeUndefined();
    expect(adapter.schedule(job)).toBeUndefined();
    expect(adapter.unschedule(job)).toBeUndefined();
    await expect(adapter.rescheduleAll()).resolves.toEqual([]);
  });

  it('keeps the base behaviour it does not override', () => {
    adapter.register('rescheduler');
    expect(adapter.registered).toEqual(['rescheduler']);
  });
});

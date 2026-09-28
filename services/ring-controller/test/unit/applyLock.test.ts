import { describe, expect, it } from 'vitest';
import { createApplyLock } from '../../src/applyLock.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createApplyLock', () => {
  it('runs calls one at a time, in the order they were queued', async () => {
    const lock = createApplyLock();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push('a-start');
      await tick();
      order.push('a-end');
    });
    const b = lock.run(async () => {
      order.push('b-start');
      await tick();
      order.push('b-end');
    });

    await Promise.all([a, b]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('propagates a rejection to its own caller without wedging the next caller', async () => {
    const lock = createApplyLock();

    const failing = lock.run(async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    // The queue must still be usable after a rejection.
    const result = await lock.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('returns the value each queued call resolves with', async () => {
    const lock = createApplyLock();
    const value = await lock.run(async () => 42);
    expect(value).toBe(42);
  });
});

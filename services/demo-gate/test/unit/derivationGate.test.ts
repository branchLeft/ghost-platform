import { describe, expect, it } from 'vitest';
import { createDerivationGate, DerivationGateFullError } from '../../src/derivationGate.js';

/** A task that stays in flight until its own `release()` is called. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('createDerivationGate', () => {
  it('rejects a non-positive concurrency cap or a negative queue cap', () => {
    expect(() => createDerivationGate(0, 10)).toThrow('maxConcurrent');
    expect(() => createDerivationGate(1.5, 10)).toThrow('maxConcurrent');
    expect(() => createDerivationGate(4, -1)).toThrow('maxQueued');
  });

  it('runs a task immediately under the cap and returns its result', async () => {
    const gate = createDerivationGate(4, 4);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates a task rejection without leaking a permit', async () => {
    const gate = createDerivationGate(1, 1);
    await expect(
      gate.run(async () => {
        throw new Error('derivation failed');
      })
    ).rejects.toThrow('derivation failed');
    // The permit released on the throw, so a fresh task runs immediately
    // rather than queuing behind a stuck slot.
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('never runs more than `maxConcurrent` tasks at once', async () => {
    const gate = createDerivationGate(2, 10);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      const d = deferred();
      // Yields control so queued tasks have a chance to start concurrently
      // if the gate is not actually bounding them.
      queueMicrotask(d.release);
      await d.promise;
      active -= 1;
    };
    await Promise.all([
      gate.run(task),
      gate.run(task),
      gate.run(task),
      gate.run(task),
      gate.run(task),
    ]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('queues past the cap and runs the next task only once a slot frees', async () => {
    const gate = createDerivationGate(1, 4);
    const first = deferred();
    const order: string[] = [];
    const p1 = gate.run(async () => {
      order.push('first-start');
      await first.promise;
      order.push('first-end');
    });
    const p2 = gate.run(async () => {
      order.push('second-start');
    });
    // The second task must not have started while the first still holds
    // the one available slot.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first-start']);
    first.release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('refuses a task once the queue itself is full, without touching the running slot', async () => {
    const gate = createDerivationGate(1, 1);
    const holder = deferred();
    const running = gate.run(() => holder.promise);
    const queued = gate.run(async () => 'queued');
    await expect(gate.run(async () => 'overflow')).rejects.toBeInstanceOf(DerivationGateFullError);
    holder.release();
    await expect(running).resolves.toBeUndefined();
    await expect(queued).resolves.toBe('queued');
  });

  it('names itself distinctly for callers that branch on the error', () => {
    const err = new DerivationGateFullError();
    expect(err.name).toBe('DerivationGateFullError');
    expect(err).toBeInstanceOf(Error);
  });
});

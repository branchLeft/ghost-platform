/**
 * Bounds how many argon2id derivations run at once, so a flood spread
 * across many sources cannot queue an unbounded number of derivations.
 * See ../README.md#why-a-derivation-gate-exists.
 */
export interface DerivationGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export class DerivationGateFullError extends Error {
  constructor() {
    super('argon2id derivation gate is full');
    this.name = 'DerivationGateFullError';
  }
}

export function createDerivationGate(maxConcurrent: number, maxQueued: number): DerivationGate {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive integer');
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new Error('maxQueued must be a non-negative integer');
  }

  let active = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    active -= 1;
    const resume = queue.shift();
    if (resume) {
      active += 1;
      resume();
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        if (queue.length >= maxQueued) {
          throw new DerivationGateFullError();
        }
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

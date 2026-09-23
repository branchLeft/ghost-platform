/**
 * Bounds how many argon2id derivations run at once. The per-source ceiling
 * (`ceiling.ts`) limits attempts from one source over time, but places no
 * limit on how many distinct sources can be mid-derivation together, and
 * each derivation the slot's own hash allows can hold up to 256 MiB and run
 * for as long as its parameters ask. A flood spread across many addresses
 * that never each trip their own ceiling would otherwise queue an unbounded
 * number of derivations, unbounded in memory as much as in count.
 *
 * A slot past the concurrency cap waits in a queue rather than running
 * immediately; a slot past the queue's own cap is refused outright, so the
 * bound holds under load instead of shifting into an unbounded backlog of
 * waiters. `DEFAULT_PARAMETERS` (64 MiB) times the concurrency cap is the
 * ceiling on live derivation memory this gate enforces.
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

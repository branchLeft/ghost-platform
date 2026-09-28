import { execFileSync } from 'node:child_process';

/**
 * Everything a run creates -- the export colour, the scratch database, its
 * network and volume, the env files -- registers a synchronous remover
 * here, and takes it back off once the normal path has removed it. On
 * SIGINT or SIGTERM every remover still registered runs before the process
 * exits: a signal handler that exits first leaves a second Ghost and a copy
 * of the tenant's database running with nothing to stop them.
 */
export class CleanupRegistry {
  readonly #steps = new Map<number, { label: string; step: () => void }>();
  #next = 0;

  register(label: string, step: () => void): () => void {
    const id = this.#next++;
    this.#steps.set(id, { label, step });
    return () => {
      this.#steps.delete(id);
    };
  }

  get labels(): readonly string[] {
    return [...this.#steps.values()].map((s) => s.label);
  }

  /** Newest first, every step attempted; returns the labels that threw. */
  runAll(): readonly string[] {
    const failed: string[] = [];
    const steps = [...this.#steps.entries()].reverse();
    this.#steps.clear();
    for (const [, { label, step }] of steps) {
      try {
        step();
      } catch {
        failed.push(label);
      }
    }
    return failed;
  }
}

export const processCleanup = new CleanupRegistry();

type SignalName = 'SIGINT' | 'SIGTERM';

interface SignalTarget {
  on(signal: SignalName, handler: () => void): unknown;
  removeListener(signal: SignalName, handler: () => void): unknown;
}

/** Runs every registered remover, then exits 130 (SIGINT) or 143 (SIGTERM). */
export function installSignalCleanup(
  registry: CleanupRegistry = processCleanup,
  exit: (code: number) => void = (code) => process.exit(code),
  target: SignalTarget = process
): () => void {
  const onInt = () => {
    registry.runAll();
    exit(130);
  };
  const onTerm = () => {
    registry.runAll();
    exit(143);
  };
  target.on('SIGINT', onInt);
  target.on('SIGTERM', onTerm);
  return () => {
    target.removeListener('SIGINT', onInt);
    target.removeListener('SIGTERM', onTerm);
  };
}

/**
 * A `docker` removal, synchronous so it can run inside a signal handler.
 * A resource already gone is not an error worth stopping cleanup for.
 */
export function dockerRemoveSync(argv: readonly string[], dockerCommand = 'docker'): void {
  execFileSync(dockerCommand, [...argv], {
    env: { PATH: process.env.PATH ?? '' },
    stdio: 'ignore',
  });
}

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

/**
 * Exit code for a signal that arrived while a cleanup step failed: a tenant
 * resource may still be running. 70 is not one of the codes the service
 * already uses (0, 1, 2, 130, 143).
 */
export const CLEANUP_FAILED_EXIT_CODE = 70;

/**
 * Runs every registered remover, then exits 130 (SIGINT) or 143 (SIGTERM).
 * When any remover threw, one stderr line per failed step names its label
 * and the process exits with CLEANUP_FAILED_EXIT_CODE instead. The thrown
 * error's message is never written, since it can carry paths. Exit is
 * always reached, even if a stderr write throws.
 */
export function installSignalCleanup(
  registry: CleanupRegistry = processCleanup,
  exit: (code: number) => void = (code) => process.exit(code),
  target: SignalTarget = process,
  writeStderr: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  }
): () => void {
  const cleanUpThenExit = (signal: SignalName, cleanExitCode: number): void => {
    const failedLabels = registry.runAll();
    for (const label of failedLabels) {
      try {
        writeStderr(`export-bundler: cleanup step failed on ${signal}: ${label}`);
      } catch {
        // A broken stderr must never stop the process from exiting.
      }
    }
    exit(failedLabels.length > 0 ? CLEANUP_FAILED_EXIT_CODE : cleanExitCode);
  };
  const onInt = () => {
    cleanUpThenExit('SIGINT', 130);
  };
  const onTerm = () => {
    cleanUpThenExit('SIGTERM', 143);
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

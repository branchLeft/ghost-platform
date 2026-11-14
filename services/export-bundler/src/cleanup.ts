import { execFileSync, type ChildProcess } from 'node:child_process';

/** What the registry needs of a spawned `docker` client: to see it is alive, and to kill it. */
export type TrackedChild = Pick<ChildProcess, 'kill' | 'exitCode' | 'signalCode'>;

/**
 * Everything a run creates -- the export colour, the scratch database, its
 * network and volume, the env files -- registers a synchronous remover
 * here, and takes it back off once the normal path has removed it. On
 * SIGINT or SIGTERM every remover still registered runs before the process
 * exits: a signal handler that exits first leaves a second Ghost and a copy
 * of the tenant's database running with nothing to stop them.
 *
 * A `docker` client still in flight when the signal lands is a second hole:
 * its `create` can reach the daemon after the remover's `rm -f` has already
 * found nothing to remove. So runAll() kills every tracked client first, and
 * records that it did, which tells the container removers to keep removing
 * until the container stays gone (dockerRemoveUntilGoneSync).
 */
export class CleanupRegistry {
  readonly #steps = new Map<number, { label: string; step: () => void }>();
  readonly #children = new Set<TrackedChild>();
  #next = 0;
  #killedInFlight = 0;

  register(label: string, step: () => void): () => void {
    const id = this.#next++;
    this.#steps.set(id, { label, step });
    return () => {
      this.#steps.delete(id);
    };
  }

  /** Tracks a spawned docker client until it exits; call the result on exit. */
  trackChild(child: TrackedChild): () => void {
    this.#children.add(child);
    return () => {
      this.#children.delete(child);
    };
  }

  get labels(): readonly string[] {
    return [...this.#steps.values()].map((s) => s.label);
  }

  /** How many still-running docker clients the last runAll() killed. */
  get killedInFlight(): number {
    return this.#killedInFlight;
  }

  /**
   * First SIGKILLs every tracked client still running, then runs the steps
   * newest first, every step attempted; returns the labels that threw.
   */
  runAll(): readonly string[] {
    const failed: string[] = [];
    let killed = 0;
    for (const child of this.#children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        if (child.kill('SIGKILL')) killed += 1;
      } catch {
        // Already gone between the check and the kill.
      }
    }
    this.#children.clear();
    this.#killedInFlight = killed;
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

export type SignalName = 'SIGINT' | 'SIGTERM';

export interface SignalTarget {
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

const GONE_POLLS = 20;
const GONE_POLL_MS = 200;
// A daemon can take a while to act on a create it was already sent, so absence
// must hold for about 1.8 s (ten reads) before the container is called gone.
const GONE_CONSECUTIVE_ABSENT = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `docker rm` of a container, then -- only when runAll() killed a docker
 * client that was still in flight -- keeps removing it until it stays gone.
 * A killed `docker run` may already have sent its create to the daemon, so
 * the container can appear after the first `rm -f` found nothing. Bounded at
 * 20 reads 200 ms apart (about 4 s), stops after 10 absent reads in a row,
 * repeats `rm -f` whenever the container shows up, and never throws. With
 * nothing killed this is exactly one `rm`, as before.
 */
export function dockerRemoveUntilGoneSync(
  name: string,
  dockerCommand: string,
  registry: CleanupRegistry,
  rmFlag = '-f'
): void {
  const remove = () => {
    try {
      dockerRemoveSync(['rm', rmFlag, name], dockerCommand);
    } catch {
      // Already gone, or never created.
    }
  };
  remove();
  if (registry.killedInFlight === 0) return;
  let absent = 0;
  for (let read = 0; read < GONE_POLLS; read += 1) {
    let present = true;
    try {
      dockerRemoveSync(['inspect', '--type', 'container', name], dockerCommand);
    } catch {
      present = false;
    }
    if (present) {
      absent = 0;
      remove();
    } else {
      absent += 1;
      if (absent >= GONE_CONSECUTIVE_ABSENT) return;
    }
    if (read < GONE_POLLS - 1) sleepSync(GONE_POLL_MS);
  }
}

import { createServer } from 'node:net';

// Spelled out instead of NodeJS.ErrnoException so this file has no
// dependency on the ambient @types/node globals eslint's plain
// (non-type-aware) config doesn't resolve.
function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | undefined)?.code;
}

/**
 * Structural half of the single-process invariant, held by a bound Unix
 * domain socket rather than a lock file and reclaim protocol. See
 * README.md in this directory for the design rationale and the
 * file-based designs it replaces.
 */
export class ProcessLockHeldError extends Error {
  constructor(path: string) {
    super(`ring-controller is already running (bound to ${JSON.stringify(path)})`);
    this.name = 'ProcessLockHeldError';
  }
}

export interface ProcessLock {
  release(): Promise<void>;
}

/**
 * The abstract namespace is Linux-only -- see README's "Running this"
 * section for why the controller targets Linux hosts. The leading `\0`
 * is what selects it: the socket has no filesystem entry, so nothing is
 * left to find after a crash, staleness or otherwise. A second, coarser
 * layer lives outside this code entirely: the deployed systemd unit is a
 * plain (non-templated) unit, so systemd itself only ever manages one
 * instance -- see the PR body's runbook for the unit file line.
 */
export const DEFAULT_LOCK_PATH = '\0branchleft-ring-controller';

export interface ProcessLockOptions {
  /**
   * Overrides the bind path/name. Production never passes this --
   * every controller instance binds the same well-known abstract name
   * so they collide. Tests pass a unique filesystem-backed socket path
   * per test (`.sock` files work identically to the abstract namespace
   * for everything this module relies on -- atomic bind, EADDRINUSE,
   * kernel-released on death -- and are portable to macOS, where the
   * abstract namespace itself does not exist), so unrelated test runs
   * never collide with each other or with a real controller.
   */
  path?: string;
}

/**
 * Binds `path` for this process, or refuses. No polling, no retry loop,
 * no reclaim: either the bind succeeds, meaning nothing else on this
 * machine holds it, or it fails with `EADDRINUSE`, meaning something
 * else -- alive, by construction, since the kernel would have already
 * freed a dead holder's binding -- does.
 */
export async function acquireProcessLock(options: ProcessLockOptions = {}): Promise<ProcessLock> {
  const path = options.path ?? DEFAULT_LOCK_PATH;
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      server.removeListener('listening', onListening);
      if (errorCode(err) === 'EADDRINUSE') {
        reject(new ProcessLockHeldError(path));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path });
  });

  return {
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

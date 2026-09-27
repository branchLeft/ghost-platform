import { open, readFile, rm } from 'node:fs/promises';

// Spelled out instead of NodeJS.ErrnoException so this file has no
// dependency on the ambient @types/node globals eslint's plain
// (non-type-aware) config doesn't resolve.
function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | undefined)?.code;
}

/**
 * The single-process assumption (Rob's ruling on this issue) makes the
 * in-process `ApplyLock` sufficient -- but only for as long as exactly one
 * controller process exists. Nothing about the code enforces that on its
 * own, so this is the structural half of the same invariant: a second
 * `ring-controller` started against the same lock file refuses to run,
 * the same tick it tries, rather than racing the first one's `ApplyLock`
 * without either process ever knowing about the other.
 */
export class ProcessLockHeldError extends Error {
  constructor(path: string, holderPid: number) {
    super(`ring-controller is already running (pid ${holderPid}, lock file ${path})`);
    this.name = 'ProcessLockHeldError';
  }
}

export interface ProcessLock {
  release(): Promise<void>;
}

/**
 * Exclusive-create (`wx`) is what makes the claim atomic: two processes
 * racing to open the same path can never both succeed, unlike a
 * read-then-write check. A lock file left by a process that no longer
 * exists (a crash, not a clean shutdown) is reclaimed automatically --
 * checked by signalling the recorded pid with signal 0, which the kernel
 * always answers without actually delivering a signal, rather than by
 * trusting the file's mere presence.
 */
export async function acquireProcessLock(path: string): Promise<ProcessLock> {
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(String(process.pid), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          await rm(path, { force: true });
        },
      };
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        throw err;
      }
      const holderPid = await readHolderPid(path);
      if (holderPid !== undefined && isProcessAlive(holderPid)) {
        throw new ProcessLockHeldError(path, holderPid);
      }
      // Stale: the recorded pid is gone. Safe to reclaim -- a live holder
      // would have failed the check above instead of reaching here.
      await rm(path, { force: true });
    }
  }
}

async function readHolderPid(path: string): Promise<number | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    const pid = Number.parseInt(content, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this user can't signal it --
    // still alive. Anything else (ESRCH, chiefly) means it is gone.
    return errorCode(err) === 'EPERM';
  }
}

import { link, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

export interface ProcessLockOptions {
  /**
   * Overrides `process.pid`. Production never passes this; it exists so
   * a test can simulate two distinct, genuinely concurrent processes
   * racing for the same lock file without spawning a real subprocess for
   * every case -- a real OS process cannot literally run two of itself
   * under one pid, so anything simulating "two live holders" from inside
   * one test process needs a way to say so.
   */
  selfPid?: number;
  /** Overrides the real `kill(pid, 0)` liveness probe. Test-only, for the same reason as `selfPid`. */
  isAlive?: (pid: number) => boolean;
}

interface LockHolder {
  pid: number;
  /** Distinguishes this process instance from any other, including a later one that reuses the same pid. */
  instanceId: string;
}

const RECLAIM_RETRY_DELAY_MS = 25;

/**
 * Claims `path` for this process, or refuses. The file is created by
 * writing its full content to a temp file in the same directory first,
 * then `link()`-ing that temp file into place -- `link` fails with
 * `EEXIST` if the destination exists, same as `open(path, 'wx')` would,
 * but unlike `open`+`write`, the destination is never observably empty:
 * by the time anything can see it exist, it already holds its final
 * content. A prior version created the file empty and wrote the pid into
 * it afterwards, which let a second starter that read the file in that
 * gap decide, wrongly, that the lock was unheld and delete it.
 */
export async function acquireProcessLock(
  path: string,
  options: ProcessLockOptions = {}
): Promise<ProcessLock> {
  const selfPid = options.selfPid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const holder: LockHolder = { pid: selfPid, instanceId: randomUUID() };
  const content = JSON.stringify(holder);

  for (;;) {
    if (await tryLinkIntoPlace(path, content)) {
      return {
        release: async () => {
          // Only ever remove the file if it is still the one this call
          // created -- otherwise a lock this process no longer holds
          // (stolen by nothing legitimate, but defensively checked
          // anyway) would be deleted out from under whoever holds it now.
          const current = await readHolder(path);
          if (current?.instanceId === holder.instanceId) {
            await rm(path, { force: true });
          }
        },
      };
    }

    const existing = await readHolder(path);
    if (existing && existing.pid !== selfPid && isAlive(existing.pid)) {
      throw new ProcessLockHeldError(path, existing.pid);
    }
    // Stale (the recorded pid is gone), or the recorded pid is this very
    // process's own -- which can only mean a leftover file from a
    // predecessor that happened to be given the same pid (routine inside
    // a container, where a fresh instance commonly restarts as pid 1),
    // never a second live holder racing us: nothing else can concurrently
    // *be* this same identity.
    await reclaimStaleLock(path, selfPid, isAlive);
    // Loop back and try the real claim again.
  }
}

async function tryLinkIntoPlace(path: string, content: string): Promise<boolean> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${randomUUID()}.tmp`);
  const handle = await open(tmpPath, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmpPath, path);
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') {
      throw err;
    }
    return false;
  } finally {
    await rm(tmpPath, { force: true });
  }
  await syncDirectory(dir);
  return true;
}

/**
 * Two starters can both observe the same stale (dead-pid, or self-pid)
 * lock file at once. Deleting it unconditionally, as a bare `rm` would,
 * lets both believe they cleared it and both then successfully `link()`
 * their own claim in turn -- which means both walk away believing they
 * are the sole holder. The arbitration file below is a second, disposable
 * lock whose only job is to serialise the "is this really stale, and if
 * so, clear it" decision, so only one of any number of racing starters
 * ever performs the reclaim.
 */
async function reclaimStaleLock(
  path: string,
  selfPid: number,
  isAlive: (pid: number) => boolean
): Promise<void> {
  const arbitrationPath = `${path}.reclaim`;
  const gotArbitration = await claimArbitration(arbitrationPath, selfPid, isAlive);
  if (!gotArbitration) {
    // Someone else is already deciding. Don't reclaim in parallel --
    // wait a beat and let the outer loop re-read the world from scratch.
    await sleep(RECLAIM_RETRY_DELAY_MS);
    return;
  }
  try {
    // Re-check under arbitration: the holder seen before taking this
    // second lock may already have been replaced by a genuine new one
    // while this process was getting here.
    const holder = await readHolder(path);
    if (holder && holder.pid !== selfPid && isAlive(holder.pid)) {
      return;
    }
    await rm(path, { force: true });
  } finally {
    await rm(arbitrationPath, { force: true });
  }
}

/** The arbitration file itself can go stale the same narrow way, if its holder crashes between claiming it and releasing it -- so it gets the same dead-pid check, not an unconditional `rm`. */
async function claimArbitration(
  arbitrationPath: string,
  selfPid: number,
  isAlive: (pid: number) => boolean
): Promise<boolean> {
  if (await tryExclusiveCreate(arbitrationPath, String(selfPid))) {
    return true;
  }
  const arbiterPid = await readPlainPid(arbitrationPath);
  if (arbiterPid !== undefined && arbiterPid !== selfPid && isAlive(arbiterPid)) {
    return false;
  }
  await rm(arbitrationPath, { force: true });
  return tryExclusiveCreate(arbitrationPath, String(selfPid));
}

async function tryExclusiveCreate(path: string, content: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') {
      throw err;
    }
    return false;
  }
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as Partial<LockHolder>;
    if (typeof parsed.pid === 'number' && typeof parsed.instanceId === 'string') {
      return { pid: parsed.pid, instanceId: parsed.instanceId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readPlainPid(path: string): Promise<number | undefined> {
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

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

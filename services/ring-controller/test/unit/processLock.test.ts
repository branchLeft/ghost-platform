import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { ProcessLockHeldError, acquireProcessLock } from '../../src/processLock.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('ring-controller-processlock-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A pid that cannot belong to any live process on any platform this runs on. */
const DEAD_PID = 999_999_999;

describe('acquireProcessLock', () => {
  it('writes this process pid into the lock file', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');

    const lock = await acquireProcessLock(path);

    expect(await readFile(path, 'utf8')).toBe(String(process.pid));
    await lock.release();
  });

  it('a second acquire against the same path, while the first is live, refuses to start', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const first = await acquireProcessLock(path);

    // This process itself is definitely alive, so the liveness check the
    // second acquire runs against the recorded pid (this process's own)
    // always finds a live holder -- this is the same-process stand-in for
    // "a second controller instance", since the check is on the pid, not
    // on which object made the call.
    await expect(acquireProcessLock(path)).rejects.toThrow(ProcessLockHeldError);

    await first.release();
  });

  it('release frees the path for a later acquire', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const first = await acquireProcessLock(path);
    await first.release();

    const second = await acquireProcessLock(path);

    expect(await readFile(path, 'utf8')).toBe(String(process.pid));
    await second.release();
  });

  it('reclaims a lock file left by a pid that no longer exists', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    await writeFile(path, String(DEAD_PID), 'utf8');

    const lock = await acquireProcessLock(path);

    expect(await readFile(path, 'utf8')).toBe(String(process.pid));
    await lock.release();
  });

  it('refuses with the holder pid named in the error', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const first = await acquireProcessLock(path);

    await expect(acquireProcessLock(path)).rejects.toThrow(String(process.pid));

    await first.release();
  });

  it('rethrows a real filesystem error rather than reading it as "already held"', async () => {
    // The parent directory does not exist, so `open(path, 'wx')` fails
    // with ENOENT, not EEXIST -- a different failure than "someone else
    // holds this lock", and one this must not swallow into a false
    // ProcessLockHeldError.
    const path = join(await tempDir(), 'missing-parent', 'ring-controller.lock');

    let caught: unknown;
    await acquireProcessLock(path).catch((err: unknown) => {
      caught = err;
    });

    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ProcessLockHeldError);
    expect((caught as { code?: unknown } | undefined)?.code).toBe('ENOENT');
  });
});

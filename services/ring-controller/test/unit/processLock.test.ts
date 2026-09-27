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

async function readHolderPid(path: string): Promise<number> {
  const content = await readFile(path, 'utf8');
  return (JSON.parse(content) as { pid: number }).pid;
}

describe('acquireProcessLock', () => {
  it('writes this process pid into the lock file, never observably empty', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');

    const lock = await acquireProcessLock(path);

    expect(await readHolderPid(path)).toBe(process.pid);
    await lock.release();
  });

  it('a second acquire, simulating a genuinely different but live process, refuses to start', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const first = await acquireProcessLock(path);

    // `selfPid` alone is enough here: the recorded holder is this test's
    // own real, genuinely alive pid, and the second call just claims a
    // different identity for itself -- the real `kill(pid, 0)` liveness
    // check against the real holder pid does the rest.
    const err = await acquireProcessLock(path, { selfPid: 424242 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessLockHeldError);
    expect((err as Error).message).toContain(String(process.pid));

    await first.release();
  });

  it('release frees the path for a later acquire', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const first = await acquireProcessLock(path);
    await first.release();

    const second = await acquireProcessLock(path);

    expect(await readHolderPid(path)).toBe(process.pid);
    await second.release();
  });

  it("release only removes the lock file if it is still this call's own -- never someone else's", async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const lock = await acquireProcessLock(path);

    // Simulate the file having been legitimately replaced by a new
    // holder since this call's own acquire (the defensive case: nothing
    // in this design should let that happen today, but `release()` must
    // not assume it never will).
    await writeFile(
      path,
      JSON.stringify({ pid: DEAD_PID, instanceId: 'someone-elses-lock' }),
      'utf8'
    );

    await lock.release();

    expect(await readHolderPid(path)).toBe(DEAD_PID);
  });

  it('reclaims a lock file left by a pid that no longer exists', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    await writeFile(path, JSON.stringify({ pid: DEAD_PID, instanceId: 'dead' }), 'utf8');

    const lock = await acquireProcessLock(path);

    expect(await readHolderPid(path)).toBe(process.pid);
    await lock.release();
  });

  it('reclaims a lock file naming this very process\'s own pid -- the routine "container restart reuses pid 1" case', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    // A predecessor that happened to get this same pid, and never
    // cleaned up -- not a second live holder, since nothing else can
    // concurrently be this exact process.
    await writeFile(path, JSON.stringify({ pid: process.pid, instanceId: 'predecessor' }), 'utf8');

    const lock = await acquireProcessLock(path);

    const content = await readFile(path, 'utf8');
    expect(JSON.parse(content)).toMatchObject({ pid: process.pid });
    expect(JSON.parse(content).instanceId).not.toBe('predecessor');
    await lock.release();
  });

  it('two genuinely distinct, concurrently live identities racing for a fresh lock: exactly one wins, the other is refused outright (never deletes the winner)', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    const isAlive = (pid: number) => pid === 111 || pid === 222;

    const results = await Promise.allSettled([
      acquireProcessLock(path, { selfPid: 111, isAlive }),
      acquireProcessLock(path, { selfPid: 222, isAlive }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProcessLockHeldError);

    const winnerPid = await readHolderPid(path);
    expect([111, 222]).toContain(winnerPid);

    await (fulfilled[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it('a stale lock naming a dead pid, raced by three distinct live identities, is reclaimed by exactly one -- no double-claim, no lingering arbitration file', async () => {
    const path = join(await tempDir(), 'ring-controller.lock');
    await writeFile(path, JSON.stringify({ pid: DEAD_PID, instanceId: 'dead' }), 'utf8');
    const isAlive = (pid: number) => pid === 111 || pid === 222 || pid === 333;

    const results = await Promise.allSettled([
      acquireProcessLock(path, { selfPid: 111, isAlive }),
      acquireProcessLock(path, { selfPid: 222, isAlive }),
      acquireProcessLock(path, { selfPid: 333, isAlive }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ release(): Promise<void> }> => r.status === 'fulfilled'
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ProcessLockHeldError);
    }

    const winnerPid = await readHolderPid(path);
    expect([111, 222, 333]).toContain(winnerPid);
    await expect(readFile(`${path}.reclaim`, 'utf8')).rejects.toThrow();

    await fulfilled[0]!.value.release();
  });

  it('rethrows a real filesystem error rather than reading it as "already held"', async () => {
    // The parent directory does not exist, so writing the temp file
    // fails with ENOENT, not EEXIST -- a different failure than "someone
    // else holds this lock", and one this must not swallow into a false
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

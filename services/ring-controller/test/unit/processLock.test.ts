import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { ProcessLockHeldError, acquireProcessLock } from '../../src/processLock.js';

const dirs: string[] = [];

async function tempSocketPath(): Promise<string> {
  const dir = await makeTempDir('ring-controller-processlock-');
  dirs.push(dir);
  // A real filesystem-backed Unix domain socket path -- portable to
  // macOS, where the Linux abstract namespace this module uses in
  // production does not exist. The atomic-bind and EADDRINUSE-while-alive
  // guarantees this module relies on are identical either way. The
  // *crash*-release guarantee is NOT: a filesystem socket a killed
  // process never unlinked stays on disk and blocks a later bind with
  // the same EADDRINUSE, on every OS, which is exactly why production
  // never uses a filesystem path -- see the dedicated test below, which
  // proves that gap on purpose rather than leaving it implicit.
  return join(dir, 'ring-controller.sock');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const holderFixture = fileURLToPath(new URL('./fixtures/holdSocketPath.mjs', import.meta.url));

/** A genuinely separate process holds `path` until killed; resolves once it reports itself bound. */
function spawnHolder(path: string): Promise<import('node:child_process').ChildProcess> {
  return new Promise((resolve, reject) => {
    const holder = spawn('node', [holderFixture, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    holder.once('error', reject);
    holder.stdout!.once('data', (chunk: Buffer) => {
      if (chunk.toString().includes('holding')) resolve(holder);
    });
  });
}

describe('acquireProcessLock', () => {
  it('a fresh path binds cleanly', async () => {
    const path = await tempSocketPath();

    const lock = await acquireProcessLock({ path });

    await lock.release();
  });

  it('a second acquire against the same path, while the first is live, refuses to start -- no polling, no wait', async () => {
    const path = await tempSocketPath();
    const first = await acquireProcessLock({ path });

    await expect(acquireProcessLock({ path })).rejects.toThrow(ProcessLockHeldError);

    await first.release();
  });

  it('release frees the path for a later acquire, in the same process', async () => {
    const path = await tempSocketPath();
    const first = await acquireProcessLock({ path });
    await first.release();

    const second = await acquireProcessLock({ path });

    await second.release();
  });

  it("a second acquire refuses even against a genuinely separate, real process (not just this test's own pid)", async () => {
    const path = await tempSocketPath();
    const holder = await spawnHolder(path);

    await expect(acquireProcessLock({ path })).rejects.toThrow(ProcessLockHeldError);

    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.kill('SIGKILL');
    await exited;
  }, 10000);

  it('the error names the path', async () => {
    const path = await tempSocketPath();
    const first = await acquireProcessLock({ path });

    await expect(acquireProcessLock({ path })).rejects.toThrow(path);

    await first.release();
  });

  it('a bind failure that is not EADDRINUSE (no such directory) is rethrown, never read as "already held"', async () => {
    const dir = await makeTempDir('ring-controller-processlock-missing-');
    dirs.push(dir);
    const path = join(dir, 'missing-subdir', 'ring-controller.sock');

    let caught: unknown;
    await acquireProcessLock({ path }).catch((err: unknown) => {
      caught = err;
    });

    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ProcessLockHeldError);
    expect((caught as { code?: unknown } | undefined)?.code).not.toBe('EADDRINUSE');
  });

  it("documents the seam's one real gap: a filesystem socket left by a killed process stays on disk and blocks a later bind -- this is exactly why production binds the abstract namespace, never a path", async () => {
    const path = await tempSocketPath();
    const holder = await spawnHolder(path);

    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.kill('SIGKILL');
    await exited;

    // Unlike the abstract namespace, the kernel does not reclaim a
    // filesystem path on its own -- the dead process's socket file is
    // still there, and libuv's own bind refuses to reuse an existing
    // path at all, whether or not anything is still listening on it.
    await expect(acquireProcessLock({ path })).rejects.toThrow(ProcessLockHeldError);
  }, 10000);

  it.skipIf(process.platform !== 'linux')(
    'on Linux, the abstract namespace releases the instant a real holder is killed -- no marker, no reclaim, no stale state, unlike the filesystem seam above',
    async () => {
      const path = `\0ring-controller-test-${randomUUID()}`;
      const holder = await spawnHolder(path);

      await expect(acquireProcessLock({ path })).rejects.toThrow(ProcessLockHeldError);

      const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
      holder.kill('SIGKILL');
      await exited;

      // No sleep-and-retry: the very next attempt must succeed, because
      // the kernel released the binding synchronously with the holder's
      // death, not on some later cleanup pass -- and there is no file to
      // have left behind either way.
      const lock = await acquireProcessLock({ path });
      await lock.release();
    },
    10000
  );
});

import { chmod, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileDrainFlag } from '../../src/drainFlag.js';
import { createDrainFlagStore, flagPathFor } from '../../src/drainFlagStore.js';

describe('createFileDrainFlag + createDrainFlagStore, wired together', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-drain-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads clear before the store has ever set the flag', () => {
    const flag = createFileDrainFlag(flagPathFor(dir, 'colour-1'));
    expect(flag.isSet()).toBe(false);
  });

  it('reads set once the store sets it, and clear again once cleared', async () => {
    const store = createDrainFlagStore(dir);
    const flag = createFileDrainFlag(flagPathFor(dir, 'colour-1'));

    await store.set('colour-1');
    expect(flag.isSet()).toBe(true);

    await store.clear('colour-1');
    expect(flag.isSet()).toBe(false);
  });

  it('a dangling symlink still reads as set -- presence of the entry is the whole contract', async () => {
    const path = flagPathFor(dir, 'colour-2');
    await symlink(join(dir, 'nowhere'), path);
    const flag = createFileDrainFlag(path);
    expect(flag.isSet()).toBe(true);
  });

  it('an unreadable flag directory fails closed (reads as set) -- the flag file itself is present, EACCES on lstat', async () => {
    const unreadableDir = join(dir, 'unreadable');
    const store = createDrainFlagStore(unreadableDir);
    await store.set('colour-3');
    await chmod(unreadableDir, 0o000);
    try {
      const flag = createFileDrainFlag(flagPathFor(unreadableDir, 'colour-3'));
      expect(flag.isSet()).toBe(true);
    } finally {
      await chmod(unreadableDir, 0o700);
    }
  });

  it("an execute-only directory (no read bit) with an absent flag still fails closed, via directoryIsReadable's own catch", async () => {
    // x-without-r: a name lookup that misses still ENOENTs (traversal only
    // needs x), which is exactly the branch the EACCES case above cannot
    // reach -- lstat there fails before directoryIsReadable is ever
    // called. Here isEnoent(err) is true, so directoryIsReadable(dir) runs
    // and its own accessSync(R_OK|X_OK) throws for want of R_OK.
    const executeOnlyDir = join(dir, 'execute-only');
    await mkdir(executeOnlyDir, { mode: 0o700 });
    await chmod(executeOnlyDir, 0o100);
    try {
      const flag = createFileDrainFlag(flagPathFor(executeOnlyDir, 'colour-4'));
      expect(flag.isSet()).toBe(true);
    } finally {
      await chmod(executeOnlyDir, 0o700);
    }
  });
});

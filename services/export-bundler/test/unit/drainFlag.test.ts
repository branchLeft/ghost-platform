import { mkdtemp, rm, symlink } from 'node:fs/promises';
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

  it('an unreadable flag directory fails closed (reads as set)', async () => {
    const unreadableDir = join(dir, 'unreadable');
    const store = createDrainFlagStore(unreadableDir);
    await store.set('colour-3');
    const { chmod } = await import('node:fs/promises');
    await chmod(unreadableDir, 0o000);
    try {
      const flag = createFileDrainFlag(flagPathFor(unreadableDir, 'colour-3'));
      expect(flag.isSet()).toBe(true);
    } finally {
      await chmod(unreadableDir, 0o700);
    }
  });
});

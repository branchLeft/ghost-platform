import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { createDrainFlagStore } from '../../src/drainFlag.js';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe('createDrainFlagStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('broker-drainflag-');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('set() creates the flag file for exactly the given (slot, colour)', async () => {
    const store = createDrainFlagStore(dir);
    await store.set('0' as SlotName, 'a');
    expect(await exists(join(dir, '0-a.drain'))).toBe(true);
    expect(await exists(join(dir, '0-b.drain'))).toBe(false);
  });

  it('clear() removes the flag file', async () => {
    const store = createDrainFlagStore(dir);
    await store.set('2' as SlotName, 'b');
    await store.clear('2' as SlotName, 'b');
    expect(await exists(join(dir, '2-b.drain'))).toBe(false);
  });

  it('clear() on an already-clear flag does not throw', async () => {
    const store = createDrainFlagStore(dir);
    await expect(store.clear('5' as SlotName, 'a')).resolves.toBeUndefined();
  });

  it('the two colours of one slot are independent flags', async () => {
    const store = createDrainFlagStore(dir);
    await store.set('1' as SlotName, 'a');
    await store.set('1' as SlotName, 'b');
    await store.clear('1' as SlotName, 'a');
    expect(await exists(join(dir, '1-a.drain'))).toBe(false);
    expect(await exists(join(dir, '1-b.drain'))).toBe(true);
  });

  describe('isSet -- the recovery-only read', () => {
    it('is false once cleared, true once set', async () => {
      const store = createDrainFlagStore(dir);
      expect(await store.isSet('3' as SlotName, 'a')).toBe(false);
      await store.set('3' as SlotName, 'a');
      expect(await store.isSet('3' as SlotName, 'a')).toBe(true);
      await store.clear('3' as SlotName, 'a');
      expect(await store.isSet('3' as SlotName, 'a')).toBe(false);
    });

    it('fails closed (reads as set) when the flag directory is unreadable, mirroring the sidecar', async () => {
      const restricted = join(dir, 'restricted');
      await mkdir(restricted);
      const store = createDrainFlagStore(restricted);
      await chmod(restricted, 0o000);
      try {
        expect(await store.isSet('4' as SlotName, 'a')).toBe(true);
      } finally {
        await chmod(restricted, 0o755);
      }
    });
  });
});

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  HostConflictError,
  hostHeldByAnotherSlot,
  removeSlotEntry,
  upsertSlotEntry,
} from '../../src/slotsFile.js';

describe('slotsFile', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await makeTempDir('broker-slotsfile-');
    path = join(dir, 'slots.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file on first upsert when none existed', async () => {
    await upsertSlotEntry(path, {
      host: 'a.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-a' },
    });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.slots).toEqual([
      { host: 'a.demo.test', slot: '0', gate: { kind: 'passphrase', argon2idHash: 'hash-a' } },
    ]);
  });

  it('replaces the entry for a slot by slot, even when the host changes', async () => {
    await upsertSlotEntry(path, {
      host: 'old-host.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-old' },
    });
    await upsertSlotEntry(path, {
      host: 'new-host.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-new' },
    });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.slots).toHaveLength(1);
    expect(parsed.slots[0]).toEqual({
      host: 'new-host.demo.test',
      slot: '0',
      gate: { kind: 'passphrase', argon2idHash: 'hash-new' },
    });
  });

  it('leaves other slots untouched when one is upserted', async () => {
    await upsertSlotEntry(path, {
      host: 'a.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-a' },
    });
    await upsertSlotEntry(path, {
      host: 'b.demo.test',
      slot: '1' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-b' },
    });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.slots).toHaveLength(2);
  });

  it('removes only the named slot', async () => {
    await upsertSlotEntry(path, {
      host: 'a.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-a' },
    });
    await upsertSlotEntry(path, {
      host: 'b.demo.test',
      slot: '1' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-b' },
    });
    await removeSlotEntry(path, '0' as SlotName);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.slots).toEqual([
      { host: 'b.demo.test', slot: '1', gate: { kind: 'passphrase', argon2idHash: 'hash-b' } },
    ]);
  });

  it('removing from a file that does not exist yet is a no-op, not a throw', async () => {
    await expect(removeSlotEntry(path, '0' as SlotName)).resolves.toBeUndefined();
  });

  it('upsertSlotEntry refuses a host already held by a different slot, atomically (F8)', async () => {
    await upsertSlotEntry(path, {
      host: 'shared.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-0' },
    });
    const attempt = upsertSlotEntry(path, {
      host: 'shared.demo.test',
      slot: '1' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-1' },
    });
    await expect(attempt).rejects.toBeInstanceOf(HostConflictError);
    await expect(attempt.catch((e) => e)).resolves.toMatchObject({
      host: 'shared.demo.test',
      heldBySlot: '0',
    });
    // The refused write must not have touched the file.
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.slots).toHaveLength(1);
  });

  it('upsertSlotEntry allows the SAME slot to update the host it already holds (a recycle changing hostname)', async () => {
    await upsertSlotEntry(path, {
      host: 'old.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-0' },
    });
    await expect(
      upsertSlotEntry(path, {
        host: 'old.demo.test',
        slot: '0' as SlotName,
        gate: { kind: 'passphrase', argon2idHash: 'hash-0-new' },
      })
    ).resolves.toBeUndefined();
  });

  it('hostHeldByAnotherSlot reports the holding slot, or null when free', async () => {
    await upsertSlotEntry(path, {
      host: 'a.demo.test',
      slot: '0' as SlotName,
      gate: { kind: 'passphrase', argon2idHash: 'hash-a' },
    });
    expect(await hostHeldByAnotherSlot(path, 'a.demo.test', '1' as SlotName)).toBe('0');
    expect(await hostHeldByAnotherSlot(path, 'a.demo.test', '0' as SlotName)).toBeNull();
    expect(
      await hostHeldByAnotherSlot(path, 'nobody-has-this.demo.test', '0' as SlotName)
    ).toBeNull();
  });

  it('propagates a read failure that is not ENOENT rather than treating it as an empty file', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path); // a directory where the slots file is expected -> EISDIR, not ENOENT
    await expect(
      upsertSlotEntry(path, {
        host: 'a.demo.test',
        slot: '0' as SlotName,
        gate: { kind: 'passphrase', argon2idHash: 'h' },
      })
    ).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

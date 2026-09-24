import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { readSlotState, writeSlotState } from '../../src/stateStore.js';

describe('stateStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('broker-statestore-');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads "free" for a slot with no state file yet', async () => {
    expect(await readSlotState(dir, '0' as SlotName)).toEqual({ phase: 'free' });
  });

  it('round-trips a running state with colour and descriptorHash', async () => {
    const slot = '2' as SlotName;
    await writeSlotState(dir, slot, { phase: 'running', colour: 'b', descriptorHash: 'abc123' });
    expect(await readSlotState(dir, slot)).toEqual({
      phase: 'running',
      colour: 'b',
      descriptorHash: 'abc123',
    });
  });

  it('one slot writing state does not affect another slot', async () => {
    await writeSlotState(dir, '0' as SlotName, {
      phase: 'running',
      colour: 'a',
      descriptorHash: 'h0',
    });
    expect(await readSlotState(dir, '1' as SlotName)).toEqual({ phase: 'free' });
  });

  it('overwrites the previous state for the same slot', async () => {
    const slot = '3' as SlotName;
    await writeSlotState(dir, slot, { phase: 'running', colour: 'a', descriptorHash: 'h1' });
    await writeSlotState(dir, slot, { phase: 'free' });
    expect(await readSlotState(dir, slot)).toEqual({ phase: 'free' });
  });

  it('propagates a read failure that is not ENOENT rather than silently reading as free', async () => {
    // A directory sitting where the state file is expected fails EISDIR --
    // a real, distinct failure mode from "no state file yet" that must not
    // be folded into the same "free" answer.
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(dir, 'sub.json'));
    await expect(readSlotState(dir, 'sub' as SlotName)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

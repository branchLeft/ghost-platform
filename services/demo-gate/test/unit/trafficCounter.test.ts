import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSlotName } from '@branchleft/ghost-platform-render-core';
import { createTrafficCounterStore, resetTrafficCounter } from '../../src/trafficCounter.js';

const SLOT = validateSlotName('0');
const OTHER_SLOT = validateSlotName('1');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traffic-counter-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readCount(path: string): Promise<number> {
  return Number.parseInt(await readFile(path, 'utf8'), 10);
}

describe('createTrafficCounterStore', () => {
  it('starts a slot at 1 on its first increment -- no file yet is 0, not an error', async () => {
    const store = createTrafficCounterStore(dir);
    await store.increment(SLOT);
    expect(await readCount(join(dir, '0.count'))).toBe(1);
  });

  it('accumulates across repeated increments', async () => {
    const store = createTrafficCounterStore(dir);
    await store.increment(SLOT);
    await store.increment(SLOT);
    await store.increment(SLOT);
    expect(await readCount(join(dir, '0.count'))).toBe(3);
  });

  it('keeps each slot in its own file', async () => {
    const store = createTrafficCounterStore(dir);
    await store.increment(SLOT);
    await store.increment(OTHER_SLOT);
    await store.increment(SLOT);
    expect(await readCount(join(dir, '0.count'))).toBe(2);
    expect(await readCount(join(dir, '1.count'))).toBe(1);
  });

  it('loses no increments under concurrency -- the read-modify-write is serialised, not raced', async () => {
    const store = createTrafficCounterStore(dir);
    // 25 concurrent increments against one slot: a store that raced
    // read-then-write (rather than queueing) would lose some of these --
    // the control case for this test is the same code with the queue
    // removed, which this file's own sabotage record (PR body) shows
    // undercounts.
    await Promise.all(Array.from({ length: 25 }, () => store.increment(SLOT)));
    expect(await readCount(join(dir, '0.count'))).toBe(25);
  });

  it('resetTrafficCounter clears a slot back to a clean start', async () => {
    const store = createTrafficCounterStore(dir);
    await store.increment(SLOT);
    await resetTrafficCounter(dir, SLOT);
    await store.increment(SLOT);
    expect(await readCount(join(dir, '0.count'))).toBe(1);
  });

  it('resetTrafficCounter is a no-op when the slot was never counted', async () => {
    await expect(resetTrafficCounter(dir, SLOT)).resolves.toBeUndefined();
  });
});

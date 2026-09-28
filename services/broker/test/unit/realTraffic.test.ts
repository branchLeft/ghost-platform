import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  createFileRealTrafficChecker,
  createZeroRealTrafficChecker,
} from '../../src/realTraffic.js';

const SLOT = '0' as SlotName;

describe('createFileRealTrafficChecker', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('broker-real-traffic-');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads 0 for a slot demo-gate has never counted -- no file yet, not an error', async () => {
    const checker = createFileRealTrafficChecker(dir);
    expect(await checker.readCount(SLOT)).toBe(0);
  });

  it("reads exactly what demo-gate's own counter file holds", async () => {
    await writeFile(join(dir, '0.count'), '42', 'utf8');
    const checker = createFileRealTrafficChecker(dir);
    expect(await checker.readCount(SLOT)).toBe(42);
  });

  it('fails closed to 0 on a non-numeric file, rather than throwing or trusting garbage as "some traffic"', async () => {
    await writeFile(join(dir, '0.count'), 'not-a-number', 'utf8');
    const checker = createFileRealTrafficChecker(dir);
    expect(await checker.readCount(SLOT)).toBe(0);
  });

  it('fails closed to 0 when the directory itself does not exist', async () => {
    await rm(dir, { recursive: true, force: true });
    const checker = createFileRealTrafficChecker(dir);
    expect(await checker.readCount(SLOT)).toBe(0);
  });
});

describe('createZeroRealTrafficChecker', () => {
  it('always reads 0 -- the safe default when no counter directory is configured at all', async () => {
    const checker = createZeroRealTrafficChecker();
    expect(await checker.readCount(SLOT)).toBe(0);
    expect(await checker.readCount('1' as SlotName)).toBe(0);
  });
});

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashIdOf,
  leaseRecordFileName,
  parseSlotLeaseRecord,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  clearLeaseAndHash,
  writeLeaseAndHash,
  type LeaseStoreConfig,
} from '../../src/leaseStore.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

describe('leaseStore', () => {
  let dir: string;
  let config: LeaseStoreConfig;

  beforeEach(async () => {
    dir = await makeTempDir('broker-leasestore-');
    config = {
      slotsPath: join(dir, 'slots.json'),
      leaseDir: dir,
      nowMs: () => 1_700_000_000_000,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a lease record whose hashId is hashIdOf() of the exact hash written to the slots file', async () => {
    const slot = '0' as SlotName;
    const { lease, hashId } = await writeLeaseAndHash(config, 'k7m.demo.test', slot, HASH);

    expect(hashId).toBe(hashIdOf(HASH));

    const recordText = await readFile(join(dir, leaseRecordFileName(slot)), 'utf8');
    const record = parseSlotLeaseRecord(recordText, slot);
    expect(record.lease).toBe(lease);
    expect(record.hashId).toBe(hashId);

    const slotsText = await readFile(config.slotsPath, 'utf8');
    const slots = JSON.parse(slotsText);
    expect(slots.slots).toEqual([
      { host: 'k7m.demo.test', slot: '0', gate: { kind: 'passphrase', argon2idHash: HASH } },
    ]);
  });

  it('mints a different lease id and a different-looking record on a second write (recycle)', async () => {
    const slot = '0' as SlotName;
    const first = await writeLeaseAndHash(config, 'k7m.demo.test', slot, HASH);
    const secondHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$bGFzaA';
    const second = await writeLeaseAndHash(config, 'k7m.demo.test', slot, secondHash);

    expect(second.lease).not.toBe(first.lease);
    expect(second.hashId).not.toBe(first.hashId);
  });

  it('clearLeaseAndHash removes both the lease record and the slots-file entry', async () => {
    const slot = '0' as SlotName;
    await writeLeaseAndHash(config, 'k7m.demo.test', slot, HASH);

    await clearLeaseAndHash(config, slot);

    await expect(readFile(join(dir, leaseRecordFileName(slot)), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const slots = JSON.parse(await readFile(config.slotsPath, 'utf8'));
    expect(slots.slots).toEqual([]);
  });

  it('clearing an unleased slot is a no-op, not a throw', async () => {
    await expect(clearLeaseAndHash(config, '0' as SlotName)).resolves.toBeUndefined();
  });

  it('clearing one slot leaves another slot leased and correctly tied', async () => {
    await writeLeaseAndHash(config, 'a.demo.test', '0' as SlotName, HASH);
    const otherHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$Y2FzaA';
    await writeLeaseAndHash(config, 'b.demo.test', '1' as SlotName, otherHash);

    await clearLeaseAndHash(config, '0' as SlotName);

    const record = parseSlotLeaseRecord(
      await readFile(join(dir, leaseRecordFileName('1' as SlotName)), 'utf8'),
      '1' as SlotName
    );
    expect(record.hashId).toBe(hashIdOf(otherHash));
  });
});

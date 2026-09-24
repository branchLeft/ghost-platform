import { join } from 'node:path';
import {
  hashIdOf,
  leaseRecordFileName,
  type HashId,
  type LeaseId,
  type SlotLeaseRecord,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import { removeFileIfPresent, writeFileAtomic } from './atomicFile.js';
import { generateLeaseId } from './ulid.js';
import { removeSlotEntry, upsertSlotEntry, type SlotsFileEntry } from './slotsFile.js';

export interface LeaseStoreConfig {
  readonly slotsPath: string;
  readonly leaseDir: string;
  readonly nowMs: () => number;
  readonly randomBytes?: (n: number) => Buffer;
}

/**
 * The recycle contract this story was told to honour verbatim
 * (workspace#1302 comment 5799768388, mirrored in `render-core/src/lease.ts`):
 * every recycle replaces the slot's hash, and the lease record it writes
 * must carry `hashIdOf` of that same hash, computed the one way
 * `render-core` defines it -- never re-derived. Both writes happen here,
 * hash first (good practice per LLD-2 §02) then the lease record, but nothing
 * downstream is allowed to depend on that order: `hashId` is the only tie
 * the gate trusts.
 */
export async function writeLeaseAndHash(
  config: LeaseStoreConfig,
  host: string,
  slot: SlotName,
  argon2idHash: string
): Promise<{ readonly lease: LeaseId; readonly hashId: HashId }> {
  const hashId = hashIdOf(argon2idHash);
  const entry: SlotsFileEntry = { host, slot, gate: { kind: 'passphrase', argon2idHash } };
  await upsertSlotEntry(config.slotsPath, entry);

  const lease = generateLeaseId(config.nowMs(), config.randomBytes);
  const record: SlotLeaseRecord = { slot, lease, hashId };
  await writeFileAtomic(join(config.leaseDir, leaseRecordFileName(slot)), JSON.stringify(record));

  return { lease, hashId };
}

/**
 * Removes both files outright rather than writing either one "cleared":
 * an absent hash and an absent lease record both already read as "no
 * current lease" everywhere they are read (`services/demo-gate`'s
 * `login()` treats a missing lease exactly like an untied one), so there is
 * no clean-slate value worth writing that absence does not already mean.
 */
export async function clearLeaseAndHash(
  config: Pick<LeaseStoreConfig, 'slotsPath' | 'leaseDir'>,
  slot: SlotName
): Promise<void> {
  await removeSlotEntry(config.slotsPath, slot);
  await removeFileIfPresent(join(config.leaseDir, leaseRecordFileName(slot)));
}

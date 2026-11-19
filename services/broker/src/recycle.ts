import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  leaseRecordFileName,
  parseSlotLeaseRecord,
  type LeaseId,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import type { LeaseStoreConfig } from './leaseStore.js';
import { hostOfSlotEntry } from './slotsFile.js';

/**
 * What a recycle must still clean up once the slot is wiped, captured before
 * the lease record and the slots-file entry are removed (afterwards nothing
 * on disk names them). Carried in the slot's state until the slot is `free`,
 * so a recycle that failed part-way and is retried still knows which lease's
 * mail to purge and which hostname to retire. See recycle.md.
 */
export interface RetiringLease {
  readonly lease: LeaseId;
  /** The hostname the slot's gate entry named, or `null` if it had none. */
  readonly host: string | null;
}

/**
 * The two recycle residues the broker cannot remove itself: the lease's
 * unsent mail (the spool belongs to `mailgun-shim`) and the hostname's place
 * in the register (the register belongs to the portal). Each is idempotent: a
 * retry after a failure part-way repeats it harmlessly. Each rejects rather
 * than resolve when it cannot be sure the residue is gone, because `/reset`
 * only ever ends `free` after both have resolved.
 */
export interface RecycleEffects {
  /** Removes the lease's unsent mail and nothing else's (the spool's `purgeLease`). */
  purgeUnsentMail(lease: LeaseId): Promise<void>;
  /** Appends the hostname's retirement to the register: never edited, never reissued. */
  retireHostname(host: string): Promise<void>;
}

/**
 * The effects a broker runs with until a real purge and a real register are
 * wired in: both reject, so a slot that held a lease is never marked `free`
 * with its mail unpurged and its hostname still live in the register. A slot
 * that held no lease has nothing to purge and never reaches them.
 */
export const UNWIRED_RECYCLE_EFFECTS: RecycleEffects = {
  async purgeUnsentMail() {
    throw new Error('no mail purge is wired into this broker');
  },
  async retireHostname() {
    throw new Error('no hostname register is wired into this broker');
  },
};

/**
 * The lease the slot holds now, or `null` when it holds none (never
 * reconciled, or already cleared). A lease record that exists but cannot be
 * read throws: the lease it names is unknown, so its mail could not be purged.
 */
export async function readRetiringLease(
  config: Pick<LeaseStoreConfig, 'slotsPath' | 'leaseDir'>,
  slot: SlotName
): Promise<RetiringLease | null> {
  let text: string;
  try {
    text = await readFile(join(config.leaseDir, leaseRecordFileName(slot)), 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
  const record = parseSlotLeaseRecord(text, slot);
  return { lease: record.lease, host: await hostOfSlotEntry(config.slotsPath, slot) };
}

/**
 * Runs the two effects in order, the mail first. The hostname is retired only
 * once its mail is gone, so a retired name never has unsent mail behind it.
 */
export async function runRecycleEffects(
  effects: RecycleEffects,
  retiring: RetiringLease
): Promise<void> {
  await effects.purgeUnsentMail(retiring.lease);
  if (retiring.host !== null) await effects.retireHostname(retiring.host);
}

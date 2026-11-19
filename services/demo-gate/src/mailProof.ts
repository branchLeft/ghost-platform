import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateLeaseId,
  validateSlotName,
  type LeaseId,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';

/** The record that a demo's mail path works: mailProof.md. */
export interface MailProof {
  readonly slot: SlotName;
  readonly lease: LeaseId;
  /** Whole seconds since the epoch. */
  readonly provedAt: number;
}

const MAX_PROOF_BYTES = 512;
/** A proof dated further ahead than this is refused: it was not made by a clock we trust. */
const MAX_PROOF_SKEW_SECONDS = 60;

export function mailProofFileName(slot: SlotName): string {
  return `${slot}.mail.json`;
}

export function parseMailProof(text: string, slot: SlotName): MailProof {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mail proof must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'lease,provedAt,slot') {
    throw new Error('mail proof must have exactly slot, lease and provedAt');
  }
  if (validateSlotName(record.slot as string) !== slot) {
    throw new Error('mail proof names another slot');
  }
  if (!Number.isSafeInteger(record.provedAt) || (record.provedAt as number) <= 0) {
    throw new Error('mail proof provedAt must be a positive whole number of seconds');
  }
  return {
    slot,
    lease: validateLeaseId(record.lease as string),
    provedAt: record.provedAt as number,
  };
}

/** Reads a slot's proof; any failure is thrown, and a caller treats a throw as "not proved". */
export function createMailProofReader(dir: string): (slot: SlotName) => Promise<MailProof> {
  return async (slot) => {
    const handle = await open(
      join(dir, mailProofFileName(slot)),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const buffer = Buffer.alloc(MAX_PROOF_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PROOF_BYTES) throw new Error('mail proof is too large');
      return parseMailProof(buffer.subarray(0, bytesRead).toString('utf8'), slot);
    } finally {
      await handle.close();
    }
  };
}

/**
 * Whether `proof` shows the mail path working for the lease now held: the
 * same lease, proved no longer ago than `maxAgeSeconds`, and not dated ahead.
 */
export function mailPathProved(
  proof: MailProof | null,
  current: LeaseId,
  nowSeconds: number,
  maxAgeSeconds: number
): boolean {
  if (proof === null || proof.lease !== current) return false;
  if (proof.provedAt > nowSeconds + MAX_PROOF_SKEW_SECONDS) return false;
  return nowSeconds - proof.provedAt <= maxAgeSeconds;
}

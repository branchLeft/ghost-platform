import { readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  leaseRecordFileName,
  MAX_LEASE_RECORD_BYTES,
  parseSlotLeaseRecord,
  validateSlotName,
  type GateSpec,
  type LeaseId,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';
import { join } from 'node:path';
import { parseArgon2idHash, type Argon2idHash } from './argon2id.js';

/** One gated demo host, as the edge renders it from a descriptor's hostname and gate. */
export interface GatedHost {
  readonly host: string;
  readonly slot: SlotName;
  readonly hash: Argon2idHash;
}

export class SlotsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotsFormatError';
  }
}

const HOST_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_SLOTS_BYTES = 256 * 1024;

function parseGate(gate: unknown, where: string): Argon2idHash {
  if (typeof gate !== 'object' || gate === null) {
    throw new SlotsFormatError(`${where}.gate must be an object.`);
  }
  const spec = gate as GateSpec;
  // A host sent through this service is gated by definition. A `none` gate
  // here is a rendering mistake, and admitting on it would open the host.
  if (spec.kind !== 'passphrase') {
    throw new SlotsFormatError(`${where}.gate must be a passphrase gate.`);
  }
  const keys = Object.keys(spec).sort().join(',');
  if (keys !== 'argon2idHash,kind') {
    throw new SlotsFormatError(`${where}.gate must have exactly kind and argon2idHash.`);
  }
  try {
    return parseArgon2idHash(spec.argon2idHash);
  } catch (err) {
    throw new SlotsFormatError(`${where}.gate: ${(err as Error).message}`);
  }
}

/**
 * Parses the whole file or refuses the whole file: one malformed entry must
 * not leave the other entries half-loaded beside it.
 */
export function parseSlots(text: string): ReadonlyMap<string, GatedHost> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SlotsFormatError('slots file is not valid JSON.');
  }
  const root = parsed as { slots?: unknown } | null;
  if (typeof root !== 'object' || root === null || !Array.isArray(root.slots)) {
    throw new SlotsFormatError('slots file must be an object with a "slots" array.');
  }
  const byHost = new Map<string, GatedHost>();
  const seenSlots = new Set<string>();
  root.slots.forEach((entry: unknown, index) => {
    const where = `slots[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new SlotsFormatError(`${where} must be an object.`);
    }
    const { host, slot, gate, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      throw new SlotsFormatError(`${where} has unknown keys: ${Object.keys(rest).join(', ')}.`);
    }
    if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
      throw new SlotsFormatError(`${where}.host must be a lowercase hostname.`);
    }
    let slotName: SlotName;
    try {
      slotName = validateSlotName(slot as string, `${where}.slot`);
    } catch (err) {
      throw new SlotsFormatError((err as Error).message);
    }
    if (byHost.has(host)) throw new SlotsFormatError(`${where}.host "${host}" appears twice.`);
    if (seenSlots.has(slotName)) {
      throw new SlotsFormatError(`${where}.slot "${slotName}" appears twice.`);
    }
    seenSlots.add(slotName);
    byHost.set(host, { host, slot: slotName, hash: parseGate(gate, where) });
  });
  return byHost;
}

/**
 * The slots file, read afresh on every call: a recycled slot gets a new
 * passphrase and often a new host, and the previous visitor's hash must stop
 * working the moment the file changes. A parse is reused only while the
 * file's bytes are identical.
 */
export function createSlotsSource(path: string): () => Promise<ReadonlyMap<string, GatedHost>> {
  let cached: { text: string; slots: ReadonlyMap<string, GatedHost> } | undefined;
  return async () => {
    const text = await readFile(path, 'utf8');
    if (text.length > MAX_SLOTS_BYTES) throw new SlotsFormatError('slots file is too large.');
    if (cached?.text !== text) cached = { text, slots: parseSlots(text) };
    return cached.slots;
  };
}

/**
 * Reads the slot's current lease from the broker's lease record. Any failure
 * -- a missing record, a symlink, an unreadable or malformed file -- is
 * thrown, and every caller treats a throw as "no current lease": a slot that
 * cannot prove who holds it admits nobody.
 */
export function createLeaseReader(dir: string): (slot: SlotName) => Promise<LeaseId> {
  return async (slot) => {
    // O_NOFOLLOW: the record is written by the broker in place; a symlink
    // where a record should be is not a record.
    const handle = await open(
      join(dir, leaseRecordFileName(slot)),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const buffer = Buffer.alloc(MAX_LEASE_RECORD_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return parseSlotLeaseRecord(buffer.subarray(0, bytesRead).toString('utf8'), slot).lease;
    } finally {
      await handle.close();
    }
  };
}

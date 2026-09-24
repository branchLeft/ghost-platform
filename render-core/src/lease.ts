/**
 * The lease: which visitor currently holds a demo slot.
 *
 * Runtime state, not intent, so it is deliberately not a descriptor field —
 * the descriptor says what a tenant was promised and changes on a decision;
 * the lease changes on every recycle and is written by machinery. The broker
 * writes one lease record per slot whenever it reconciles or resets that
 * slot, and every consumer that must forget the previous visitor keys on the
 * same id from the same record: the demo edge's gate refuses a cookie issued
 * against any other lease, and the mail spool purges the queue of a lease
 * that is no longer current. Both read it through `parseSlotLeaseRecord`, so
 * there is one definition of the id and one of where it lives.
 *
 * **The broker's contract on recycle (both required, the second enforced by
 * `hashId` below rather than trusted):**
 *
 * (a) **The slot's `argon2id` hash must be replaced on every recycle.** A
 *     lease that outlives the passphrase it was issued under is not a
 *     recycle at all — the previous visitor, and anyone they shared the
 *     passphrase with, simply logs in again. Nothing downstream of the
 *     broker can detect an unrotated hash; this is a broker-discipline
 *     requirement, not a checkable invariant.
 * (b) **The new hash and the new lease record name the same tenancy.** The
 *     slots file (the hash) and a slot's lease record live in two files the
 *     broker writes independently, at different moments, with no shared
 *     transaction between them. Writing the hash before the lease record is
 *     good practice, but the gate does not rely on that order: it relies on
 *     `hashId` instead. Every lease record the broker writes on recycle
 *     **must carry `hashIdOf(the hash it just wrote for this tenancy)`**,
 *     computed with this module's own function so the tag means the same
 *     thing everywhere it is checked. A reader that sees a hash and a lease
 *     record whose `hashId` fields disagree has caught two different
 *     tenancies mid-transition and must treat neither as current — see
 *     `services/demo-gate/src/app.ts`'s `login()`, which is exactly that
 *     reader.
 */

import { assertString, FieldValidationError, type Brand } from './brand.js';

/** The literal name a demo host gives one of its fixed slots, e.g. `0` or `demo-07`. */
export type SlotName = Brand<string, 'SlotName'>;
/** A ULID minted fresh by the broker for each lease; a recycled slot never reuses one. */
export type LeaseId = Brand<string, 'LeaseId'>;
/** A short correlation tag for a slot's current `argon2id` hash — see `hashIdOf`. */
export type HashId = Brand<string, 'HashId'>;

export interface SlotLeaseRecord {
  readonly slot: SlotName;
  readonly lease: LeaseId;
  readonly hashId: HashId;
}

// A DNS-label charset, and never a dot or a slash: the slot name becomes a
// file name here and a field in a dot-delimited cookie at the edge, so a
// value that could traverse a directory or split a field is refused at the
// one place it is read.
const SLOT_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSlotName(value: string, field = 'slot'): SlotName {
  assertString(value, field);
  if (!SLOT_NAME_PATTERN.test(value)) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must be 1-63 lowercase letters, digits and inner hyphens.`
    );
  }
  return value as SlotName;
}

// Crockford base32, 26 characters, first character at most 7 so the
// 128-bit value does not overflow. Uppercase only: a lease id is compared
// byte for byte, so two spellings of one id must not both be valid.
const LEASE_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function validateLeaseId(value: string, field = 'lease'): LeaseId {
  assertString(value, field);
  if (!LEASE_ID_PATTERN.test(value)) {
    throw new FieldValidationError(
      field,
      `${field} must be a 26-character uppercase ULID, e.g. "01J9F4Q7ZC3M8V2K6X0R5T1B9D".`
    );
  }
  return value as LeaseId;
}

// Lowercase hex only: like a lease id, compared byte for byte.
const HASH_ID_PATTERN = /^[0-9a-f]{16}$/;

export function validateHashId(value: string, field = 'hashId'): HashId {
  assertString(value, field);
  if (!HASH_ID_PATTERN.test(value)) {
    throw new FieldValidationError(field, `${field} must be a 16-character lowercase hex digest.`);
  }
  return value as HashId;
}

// FNV-1a, 64-bit, over the UTF-8 bytes of the PHC string. Not
// `node:crypto`: this package's own dependency-closure test bans every bare
// import specifier from `src/`, `node:crypto` included, so it can be
// bundled anywhere with no Node (or any other) runtime assumption. That
// rules out a cryptographic hash here regardless — `hashIdOf`'s own comment
// says why this tag does not need one. `BigInt` keeps the 64-bit
// arithmetic exact; a `Number` accumulator loses precision past 2^53 and
// would make two different inputs collide far more often than 64 bits
// promises.
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64Hex(text: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * A deterministic correlation tag for one `argon2id` PHC string. Not a
 * security boundary of its own — the hash it tags already sits in the
 * slots file, which is no more sensitive than this record — its only job
 * is to let a hash and a lease record written independently, at different
 * times, be recognised as belonging to the same recycle without requiring
 * their writes to be atomic or ordered with each other; 64 bits of
 * collision resistance is not remotely the limiting factor for that.
 * Both the broker (writing) and the gate (reading) must compute it with
 * this same function.
 */
export function hashIdOf(argon2idHashPhc: string): HashId {
  assertString(argon2idHashPhc, 'argon2idHashPhc');
  return fnv1a64Hex(argon2idHashPhc) as HashId;
}

/** The file, inside the broker's lease directory, that holds a slot's current lease record. */
export function leaseRecordFileName(slot: SlotName): string {
  return `${slot}.json`;
}

// A record is two short fields; anything larger is not one.
export const MAX_LEASE_RECORD_BYTES = 1024;

/**
 * Parses a lease record read from `leaseRecordFileName(expectedSlot)`. The
 * record names its own slot, and a record whose slot disagrees with the file
 * it was read from is refused: a misplaced or copied file must never make one
 * slot's lease current for another.
 */
export function parseSlotLeaseRecord(text: string, expectedSlot: SlotName): SlotLeaseRecord {
  assertString(text, 'leaseRecord');
  if (text.length > MAX_LEASE_RECORD_BYTES) {
    throw new FieldValidationError('leaseRecord', 'lease record is too large to be one.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FieldValidationError('leaseRecord', 'lease record is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FieldValidationError('leaseRecord', 'lease record must be a JSON object.');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 3 || keys[0] !== 'hashId' || keys[1] !== 'lease' || keys[2] !== 'slot') {
    throw new FieldValidationError(
      'leaseRecord',
      'lease record must have exactly the keys "slot", "lease" and "hashId".'
    );
  }
  const record = parsed as { slot: unknown; lease: unknown; hashId: unknown };
  const slot = validateSlotName(record.slot as string, 'leaseRecord.slot');
  if (slot !== expectedSlot) {
    throw new FieldValidationError(
      'leaseRecord.slot',
      `lease record names slot "${slot}" but was read for slot "${expectedSlot}".`
    );
  }
  return {
    slot,
    lease: validateLeaseId(record.lease as string, 'leaseRecord.lease'),
    hashId: validateHashId(record.hashId as string, 'leaseRecord.hashId'),
  };
}

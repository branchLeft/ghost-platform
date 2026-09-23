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
 */

import { assertString, FieldValidationError, type Brand } from './brand.js';

/** The literal name a demo host gives one of its fixed slots, e.g. `0` or `demo-07`. */
export type SlotName = Brand<string, 'SlotName'>;
/** A ULID minted fresh by the broker for each lease; a recycled slot never reuses one. */
export type LeaseId = Brand<string, 'LeaseId'>;

export interface SlotLeaseRecord {
  readonly slot: SlotName;
  readonly lease: LeaseId;
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
  if (keys.length !== 2 || keys[0] !== 'lease' || keys[1] !== 'slot') {
    throw new FieldValidationError(
      'leaseRecord',
      'lease record must have exactly the keys "slot" and "lease".'
    );
  }
  const record = parsed as { slot: unknown; lease: unknown };
  const slot = validateSlotName(record.slot as string, 'leaseRecord.slot');
  if (slot !== expectedSlot) {
    throw new FieldValidationError(
      'leaseRecord.slot',
      `lease record names slot "${slot}" but was read for slot "${expectedSlot}".`
    );
  }
  return { slot, lease: validateLeaseId(record.lease as string, 'leaseRecord.lease') };
}

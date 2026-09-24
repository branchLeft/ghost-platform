import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import {
  hashIdOf,
  leaseRecordFileName,
  MAX_LEASE_RECORD_BYTES,
  parseSlotLeaseRecord,
  validateHashId,
  validateLeaseId,
  validateSlotName,
} from '../src/index.js';

const LEASE = '01J9F4Q7ZC3M8V2K6X0R5T1B9D';
const HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFndGFndGFndGFndGFndGFndGFndGFndGE';
const HASH_ID = hashIdOf(HASH);
const slot = validateSlotName('demo-07');

describe('validateSlotName', () => {
  it.each(['0', '6', 'demo-07', 'a', 'a'.repeat(63)])('accepts %s', (value) => {
    expect(validateSlotName(value)).toBe(value);
  });

  it.each([
    ['empty', ''],
    ['a dot', 'demo.07'],
    ['a slash', '../0'],
    ['uppercase', 'Demo'],
    ['a leading hyphen', '-0'],
    ['a trailing hyphen', '0-'],
    ['too long', 'a'.repeat(64)],
  ])('rejects %s', (_label, value) => {
    expect(() => validateSlotName(value)).toThrow(FieldValidationError);
  });

  it('rejects a non-string', () => {
    expect(() => validateSlotName(7 as unknown as string)).toThrow(/must be a string/);
  });
});

describe('validateLeaseId', () => {
  it('accepts a ULID', () => {
    expect(validateLeaseId(LEASE)).toBe(LEASE);
  });

  it.each([
    ['lowercase', LEASE.toLowerCase()],
    ['25 characters', LEASE.slice(1)],
    ['27 characters', `${LEASE}0`],
    ['an excluded letter I', `01J9F4Q7ZC3M8V2K6X0R5T1B9I`],
    ['an overflowing first character', `8${LEASE.slice(1)}`],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => validateLeaseId(value)).toThrow(FieldValidationError);
  });
});

describe('leaseRecordFileName', () => {
  it('names the record after the slot', () => {
    expect(leaseRecordFileName(slot)).toBe('demo-07.json');
  });
});

describe('validateHashId', () => {
  it('accepts a 16-character lowercase hex digest', () => {
    expect(validateHashId(HASH_ID)).toBe(HASH_ID);
  });

  it.each([
    ['uppercase', HASH_ID.toUpperCase()],
    ['15 characters', HASH_ID.slice(1)],
    ['17 characters', `${HASH_ID}0`],
    ['non-hex', 'g'.repeat(16)],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => validateHashId(value)).toThrow(FieldValidationError);
  });
});

describe('hashIdOf', () => {
  it('is deterministic', () => {
    expect(hashIdOf(HASH)).toBe(hashIdOf(HASH));
  });

  it('differs for different hashes, including a one-character difference', () => {
    const other = HASH.replace('c2FsdHNhbHRzYWx0c2FsdA', 'c2FsdHNhbHRzYWx0c2FsdB');
    expect(hashIdOf(HASH)).not.toBe(hashIdOf(other));
  });

  it('is 16 lowercase hex characters, valid input to validateHashId', () => {
    const id = hashIdOf(HASH);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(validateHashId(id)).toBe(id);
  });

  it('rejects a non-string', () => {
    expect(() => hashIdOf(7 as unknown as string)).toThrow(/must be a string/);
  });
});

describe('parseSlotLeaseRecord', () => {
  it('parses a well-formed record', () => {
    expect(
      parseSlotLeaseRecord(JSON.stringify({ slot: 'demo-07', lease: LEASE, hashId: HASH_ID }), slot)
    ).toEqual({
      slot: 'demo-07',
      lease: LEASE,
      hashId: HASH_ID,
    });
  });

  it('refuses a record naming a different slot than the one it was read for', () => {
    expect(() =>
      parseSlotLeaseRecord(JSON.stringify({ slot: 'demo-08', lease: LEASE, hashId: HASH_ID }), slot)
    ).toThrow(/names slot "demo-08"/);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a missing lease', JSON.stringify({ slot: 'demo-07', hashId: HASH_ID })],
    ['a missing hashId', JSON.stringify({ slot: 'demo-07', lease: LEASE })],
    [
      'an extra key',
      JSON.stringify({ slot: 'demo-07', lease: LEASE, hashId: HASH_ID, visitor: 'x' }),
    ],
    ['a bad lease', JSON.stringify({ slot: 'demo-07', lease: 'nope', hashId: HASH_ID })],
    ['a bad hashId', JSON.stringify({ slot: 'demo-07', lease: LEASE, hashId: 'nope' })],
    ['a non-string slot', JSON.stringify({ slot: 7, lease: LEASE, hashId: HASH_ID })],
    ['too many bytes', ' '.repeat(MAX_LEASE_RECORD_BYTES + 1)],
  ])('refuses %s', (_label, text) => {
    expect(() => parseSlotLeaseRecord(text, slot)).toThrow(FieldValidationError);
  });
});

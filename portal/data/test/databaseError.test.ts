import { describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';

describe('readDatabaseError', () => {
  it('reads the SQLSTATE and constraint of a driver error', () => {
    expect(readDatabaseError({ code: '23505', constraint: 'a_pkey' })).toEqual({
      code: '23505',
      constraint: 'a_pkey',
    });
  });

  it("looks through the ORM's wrapper", () => {
    expect(
      readDatabaseError({ message: 'Failed query', cause: { code: '23503', constraint: 'a_fk' } })
    ).toEqual({ code: '23503', constraint: 'a_fk' });
  });

  it('reports no constraint when the error names none', () => {
    expect(readDatabaseError({ code: '42501' })).toEqual({ code: '42501', constraint: undefined });
  });

  it.each([
    ['a system error code', { code: 'ECONNREFUSED' }],
    ['text', 'boom'],
    ['null', null],
    ['an error with no code', new Error('boom')],
  ])('returns nothing for %s', (_name, error) => {
    expect(readDatabaseError(error)).toBeUndefined();
  });
});

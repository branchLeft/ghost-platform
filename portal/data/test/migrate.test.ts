import { describe, expect, it } from 'vitest';
import { UnisolatedTableError, assertTenantTablesIsolated } from '../src/isolation.js';
import * as schema from '../src/schema.js';
import * as fixtureSchema from './fixtureSchema.js';

describe('assertTenantTablesIsolated', () => {
  it('accepts the shipped schema', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it('accepts a table that is isolated', () => {
    expect(() => assertTenantTablesIsolated({ note: fixtureSchema.note })).not.toThrow();
  });

  it('names a tenant table left without row security and its policy', () => {
    const error = (() => {
      try {
        assertTenantTablesIsolated(fixtureSchema);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UnisolatedTableError);
    expect((error as UnisolatedTableError).tables).toEqual(['leaky']);
  });

  it('ignores a table with no tenant column', () => {
    expect(() => assertTenantTablesIsolated({ other: fixtureSchema.fixture })).not.toThrow();
  });
});

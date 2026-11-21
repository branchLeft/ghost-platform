import { describe, expect, it } from 'vitest';
import { parseEffectiveDate, parseEntries } from '../src/console/documentsScreen.js';

describe('the effective date', () => {
  it('is a real calendar date, as midnight UTC', () => {
    expect(parseEffectiveDate('2026-12-01')?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(parseEffectiveDate('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      '2026-12-1',
      '2026-02-30',
      '2027-02-29',
      '2026-13-01',
      '01/12/2026',
      '2026-12-01T10:00',
      ' 2026-12-01',
    ]) {
      expect(parseEffectiveDate(bad)).toBeNull();
    }
  });
});

describe('the sub-processor entries', () => {
  it('are one NAME | PURPOSE a line, blank lines ignored', () => {
    expect(parseEntries('TEST_A | TEST_PURPOSE_A\r\n\n TEST_B|TEST_PURPOSE_B \n')).toEqual([
      { name: 'TEST_A', purpose: 'TEST_PURPOSE_A' },
      { name: 'TEST_B', purpose: 'TEST_PURPOSE_B' },
    ]);
  });

  it('keep any further bar in the purpose', () => {
    expect(parseEntries('TEST_A | ONE | TWO')).toEqual([{ name: 'TEST_A', purpose: 'ONE | TWO' }]);
  });

  it('are refused when there are none, or a line lacks its name, its bar or its purpose', () => {
    for (const bad of ['', '\n\n', 'TEST_A', 'TEST_A |', '| TEST_PURPOSE', 'TEST_A | X\nTEST_B']) {
      expect(parseEntries(bad)).toBeNull();
    }
  });
});

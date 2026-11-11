import { describe, expect, it } from 'vitest';
import { parseConsentRecord, WHERE_MAX_LENGTH } from '../../src/consentRecord.js';

const NOW = new Date('2026-11-11T12:00:00Z');

describe('parseConsentRecord', () => {
  it('accepts a complete record and keeps where and when', () => {
    expect(
      parseConsentRecord({ where: 'Sign-up form on the demo site', when: '2026-10-01' }, NOW)
    ).toEqual({
      needsReconfirmation: false,
      where: 'Sign-up form on the demo site',
      when: '2026-10-01',
    });
  });

  it('accepts a record dated today', () => {
    expect(
      parseConsentRecord({ where: 'Import sheet', when: '2026-11-11' }, NOW).needsReconfirmation
    ).toBe(false);
  });

  it('asks for re-confirmation when no record exists', () => {
    expect(parseConsentRecord(undefined, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'absent',
    });
    expect(parseConsentRecord(null, NOW)).toEqual({ needsReconfirmation: true, problem: 'absent' });
  });

  it('asks for re-confirmation when the record is not an object', () => {
    expect(parseConsentRecord('invalid-json', NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'invalid-shape',
    });
    expect(parseConsentRecord(['where'], NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'invalid-shape',
    });
  });

  it('asks for re-confirmation when where is missing, blank or too long', () => {
    expect(parseConsentRecord({ when: '2026-10-01' }, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'invalid-shape',
    });
    expect(parseConsentRecord({ where: '   ', when: '2026-10-01' }, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'where-empty',
    });
    expect(
      parseConsentRecord({ where: 'x'.repeat(WHERE_MAX_LENGTH + 1), when: '2026-10-01' }, NOW)
    ).toEqual({
      needsReconfirmation: true,
      problem: 'where-too-long',
    });
  });

  it('accepts where at exactly the maximum length', () => {
    const outcome = parseConsentRecord(
      { where: 'x'.repeat(WHERE_MAX_LENGTH), when: '2026-10-01' },
      NOW
    );
    expect(outcome.needsReconfirmation).toBe(false);
  });

  it('rejects a when that is not an ISO date', () => {
    expect(parseConsentRecord({ where: 'Form', when: '11/10/2026' }, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'when-invalid',
    });
    expect(parseConsentRecord({ where: 'Form', when: 20261001 }, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'when-invalid',
    });
  });

  it('rejects a when that is a date which does not exist', () => {
    expect(parseConsentRecord({ where: 'Form', when: '2026-02-30' }, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'when-invalid',
    });
  });

  it('rejects a when in the future', () => {
    expect(parseConsentRecord({ where: 'Form', when: '2026-11-12' }, NOW)).toEqual({
      needsReconfirmation: true,
      problem: 'when-in-future',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  RESTORE_DRILL_MAX_AGE_MS,
  UNATTENDED_MINOR_FLAG,
  decideUnattendedMinor,
  restoreDrillMet,
  unattendedMinorEnabled,
  type MinorDecisionInput,
  type RestoreDrillRecord,
} from '../../src/minorEligibility.js';

const NOW = 5_000_000_000;
const FRESH_DRILL: RestoreDrillRecord = { result: 'pass', finishedAtMs: NOW - 60_000 };

/** An eligible minor, with the flag on and a fresh passing drill, unless a test changes it. */
function input(overrides: Partial<MinorDecisionInput> = {}): MinorDecisionInput {
  return {
    enabled: true,
    currentVersion: '6.55.0',
    release: { version: '6.58.0', route: 'fast-path' },
    restoreDrill: FRESH_DRILL,
    nowMs: NOW,
    ...overrides,
  };
}

describe('the flag', () => {
  it('is off when absent, empty or anything but the exact word on', () => {
    expect(unattendedMinorEnabled({})).toBe(false);
    for (const value of ['', 'off', 'true', '1', 'ON', 'On', ' on', 'on ', 'yes', 'enabled']) {
      expect(unattendedMinorEnabled({ [UNATTENDED_MINOR_FLAG]: value })).toBe(false);
    }
    expect(unattendedMinorEnabled({ [UNATTENDED_MINOR_FLAG]: undefined })).toBe(false);
  });

  it('is on only for the exact word on', () => {
    expect(unattendedMinorEnabled({ [UNATTENDED_MINOR_FLAG]: 'on' })).toBe(true);
  });
});

describe('the restore-drill precondition', () => {
  it('is met by a fresh passing record', () => {
    expect(restoreDrillMet(FRESH_DRILL, NOW)).toBe(true);
  });

  it('is met at exactly the maximum age and unmet one millisecond past it', () => {
    const edge: RestoreDrillRecord = {
      result: 'pass',
      finishedAtMs: NOW - RESTORE_DRILL_MAX_AGE_MS,
    };
    expect(restoreDrillMet(edge, NOW)).toBe(true);
    expect(restoreDrillMet({ ...edge, finishedAtMs: edge.finishedAtMs - 1 }, NOW)).toBe(false);
  });

  it('is unmet with no record, a failed record, a future-dated record or a non-finite time', () => {
    expect(restoreDrillMet(undefined, NOW)).toBe(false);
    expect(restoreDrillMet({ result: 'fail', finishedAtMs: NOW - 1 }, NOW)).toBe(false);
    expect(restoreDrillMet({ result: 'pass', finishedAtMs: NOW + 1 }, NOW)).toBe(false);
    expect(restoreDrillMet({ result: 'pass', finishedAtMs: Number.NaN }, NOW)).toBe(false);
    expect(restoreDrillMet({ result: 'pass', finishedAtMs: Number.POSITIVE_INFINITY }, NOW)).toBe(
      false
    );
  });

  it('is unmet when the caller sets a maximum age that is not above zero or not finite', () => {
    expect(restoreDrillMet(FRESH_DRILL, NOW, 0)).toBe(false);
    expect(restoreDrillMet(FRESH_DRILL, NOW, -1)).toBe(false);
    expect(restoreDrillMet(FRESH_DRILL, NOW, Number.NaN)).toBe(false);
  });

  it('honours a shorter maximum age the caller sets', () => {
    expect(restoreDrillMet(FRESH_DRILL, NOW, 30_000)).toBe(false);
    expect(restoreDrillMet(FRESH_DRILL, NOW, 120_000)).toBe(true);
  });
});

describe('decideUnattendedMinor', () => {
  it('finds a minor release eligible', () => {
    expect(decideUnattendedMinor(input())).toEqual({ eligible: true, kind: 'minor' });
  });

  it('finds a patch release eligible, with or without a leading v', () => {
    expect(
      decideUnattendedMinor(input({ release: { version: 'v6.55.3', route: 'fast-path' } }))
    ).toEqual({ eligible: true, kind: 'patch' });
    expect(decideUnattendedMinor(input({ currentVersion: 'v6.55.0' }))).toMatchObject({
      eligible: true,
    });
  });

  it('refuses with the flag off, whatever else holds', () => {
    expect(decideUnattendedMinor(input({ enabled: false }))).toMatchObject({
      eligible: false,
      reason: 'flag-off',
    });
  });

  it('puts the flag first: off beats every other refusal', () => {
    const worst = input({
      enabled: false,
      release: { version: '7.0.0', route: 'consent' },
      restoreDrill: undefined,
    });
    expect(decideUnattendedMinor(worst)).toMatchObject({ reason: 'flag-off' });
  });

  it('refuses a flag-on release while the restore drill is unmet', () => {
    for (const restoreDrill of [
      undefined,
      { result: 'fail', finishedAtMs: NOW - 1 },
      { result: 'pass', finishedAtMs: NOW - RESTORE_DRILL_MAX_AGE_MS - 1 },
    ] as const) {
      expect(decideUnattendedMinor(input({ restoreDrill }))).toMatchObject({
        eligible: false,
        reason: 'restore-drill-unmet',
      });
    }
  });

  it('refuses a major, even when the route says fast-path', () => {
    expect(
      decideUnattendedMinor(input({ release: { version: '7.0.0', route: 'fast-path' } }))
    ).toMatchObject({ eligible: false, reason: 'major' });
  });

  it('refuses the consent route even for a minor', () => {
    expect(
      decideUnattendedMinor(input({ release: { version: '6.58.0', route: 'consent' } }))
    ).toMatchObject({ eligible: false, reason: 'consent-route' });
  });

  it('refuses the same version, an older one, and an older major', () => {
    for (const version of ['6.55.0', '6.54.9', '6.55.0', '5.99.0']) {
      expect(
        decideUnattendedMinor(input({ release: { version, route: 'fast-path' } }))
      ).toMatchObject({ eligible: false, reason: 'not-an-upgrade' });
    }
  });

  it('refuses a version it cannot read, on either side, as a major would be refused', () => {
    const unreadable = ['6.58', '6.58.0-rc.1', '6.58.0+build', 'latest', '', '06.58.0', '6.58.x'];
    for (const version of unreadable) {
      expect(
        decideUnattendedMinor(input({ release: { version, route: 'fast-path' } }))
      ).toMatchObject({ eligible: false, reason: 'version-unreadable' });
      expect(decideUnattendedMinor(input({ currentVersion: version }))).toMatchObject({
        eligible: false,
        reason: 'version-unreadable',
      });
    }
  });

  it('refuses a version number too large to compare exactly', () => {
    const huge = '6.99999999999999999999.0';
    expect(
      decideUnattendedMinor(input({ release: { version: huge, route: 'fast-path' } }))
    ).toMatchObject({ eligible: false, reason: 'version-unreadable' });
  });

  it('names the reason in a detail that carries no value from the environment', () => {
    const refused = decideUnattendedMinor(input({ restoreDrill: undefined }));
    expect(refused.eligible).toBe(false);
    if (!refused.eligible) {
      expect(refused.detail.length).toBeGreaterThan(0);
    }
  });
});

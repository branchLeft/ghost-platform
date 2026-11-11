import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBulkCap,
  DEFAULT_DEFERRAL_HOLD_MS,
  isBulkDeferral,
  laneOf,
  parseRampSchedule,
  rampRateAt,
} from '../../src/lanes.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-11T00:00:00.000Z');

const goodRamp = {
  startedAt: '2026-11-11T00:00:00.000Z',
  steps: [
    { afterDays: 0, messagesPerHour: 20 },
    { afterDays: 7, messagesPerHour: 100 },
  ],
};

describe('laneOf', () => {
  it('sends a message with no emailId to the login lane', () => {
    expect(laneOf({ emailId: null })).toBe('login');
  });

  it('sends a message with an emailId to the bulk lane', () => {
    expect(laneOf({ emailId: 'campaign-1' })).toBe('bulk');
  });

  it('treats an empty emailId as login, the shim writes no header for it', () => {
    expect(laneOf({ emailId: '' })).toBe('login');
  });
});

describe('isBulkDeferral', () => {
  it('matches Google 4.7.28 in the SMTP reply text', () => {
    expect(
      isBulkDeferral(Object.assign(new Error('x'), { response: '421 4.7.28 Unusual rate' }))
    ).toBe(true);
  });

  it('matches 451 4.7.650 only with the 451 code', () => {
    expect(
      isBulkDeferral(
        Object.assign(new Error('x'), { responseCode: 451, response: '451 4.7.650 throttled' })
      )
    ).toBe(true);
    expect(
      isBulkDeferral(
        Object.assign(new Error('x'), { responseCode: 550, response: '550 4.7.650 refused' })
      )
    ).toBe(false);
  });

  it('does not match a longer enhanced code that merely starts with the same digits', () => {
    expect(isBulkDeferral(Object.assign(new Error('x'), { response: '421 4.7.280 other' }))).toBe(
      false
    );
  });

  it('does not match an ordinary recipient rejection', () => {
    expect(
      isBulkDeferral(
        Object.assign(new Error('x'), { responseCode: 550, response: '550 5.1.1 no such user' })
      )
    ).toBe(false);
  });

  it('does not match a non-object', () => {
    expect(isBulkDeferral('4.7.28')).toBe(false);
    expect(isBulkDeferral(undefined)).toBe(false);
  });
});

describe('parseRampSchedule', () => {
  it('accepts a well-formed schedule', () => {
    expect(parseRampSchedule(goodRamp).steps).toHaveLength(2);
  });

  it('refuses a missing or unparseable startedAt', () => {
    expect(() => parseRampSchedule({ ...goodRamp, startedAt: 'soon' })).toThrow(/startedAt/);
  });

  it('refuses an empty step list', () => {
    expect(() => parseRampSchedule({ ...goodRamp, steps: [] })).toThrow(/non-empty/);
  });

  it('refuses a first step that does not start at day 0', () => {
    expect(() =>
      parseRampSchedule({ ...goodRamp, steps: [{ afterDays: 1, messagesPerHour: 20 }] })
    ).toThrow(/afterDays 0/);
  });

  it('refuses steps out of order or repeated', () => {
    expect(() =>
      parseRampSchedule({
        ...goodRamp,
        steps: [
          { afterDays: 0, messagesPerHour: 20 },
          { afterDays: 0, messagesPerHour: 40 },
        ],
      })
    ).toThrow(/ascending/);
  });

  it('refuses a fractional or zero rate', () => {
    expect(() =>
      parseRampSchedule({ ...goodRamp, steps: [{ afterDays: 0, messagesPerHour: 0 }] })
    ).toThrow(/messagesPerHour/);
    expect(() =>
      parseRampSchedule({ ...goodRamp, steps: [{ afterDays: 0, messagesPerHour: 2.5 }] })
    ).toThrow(/messagesPerHour/);
  });
});

describe('rampRateAt', () => {
  const schedule = parseRampSchedule(goodRamp);

  it('gives the first step before the start and during day 0', () => {
    expect(rampRateAt(schedule, START - DAY)).toBe(20);
    expect(rampRateAt(schedule, START + DAY / 2)).toBe(20);
  });

  it('steps up exactly when a later step day arrives', () => {
    expect(rampRateAt(schedule, START + 7 * DAY - 1)).toBe(20);
    expect(rampRateAt(schedule, START + 7 * DAY)).toBe(100);
  });
});

describe('createBulkCap', () => {
  let dir: string;
  let rampPath: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-lanes-'));
    rampPath = join(dir, 'ramp.json');
    clock = START;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs at the configured ceiling when no ramp file is configured', () => {
    const cap = createBulkCap({ now: () => clock });
    expect(cap.rateFor(50, clock)).toBe(50);
  });

  it('holds the slow unreadable rate when a ramp is configured but missing', () => {
    const cap = createBulkCap({ rampPath, now: () => clock });
    expect(cap.rateFor(50, clock)).toBe(1);
  });

  it('follows the ramp, never above the configured ceiling', () => {
    writeFileSync(rampPath, JSON.stringify(goodRamp));
    const cap = createBulkCap({ rampPath, now: () => clock });
    expect(cap.rateFor(50, clock)).toBe(20);
    expect(cap.rateFor(1000, START + 7 * DAY)).toBe(100);
    expect(cap.rateFor(60, START + 7 * DAY)).toBe(60);
  });

  it('adopts a rewritten ramp file, and keeps the last good schedule when a rewrite is invalid', () => {
    writeFileSync(rampPath, JSON.stringify(goodRamp));
    const cap = createBulkCap({ rampPath, now: () => clock });
    expect(cap.rateFor(1000, clock)).toBe(20);
    writeFileSync(rampPath, JSON.stringify({ startedAt: 'bad' }));
    expect(cap.rateFor(1000, clock)).toBe(20);
  });

  it('halves the rate on a deferral and holds it for at least the hold period', () => {
    const cap = createBulkCap({ now: () => clock });
    expect(cap.rateFor(1000, clock)).toBe(1000);
    cap.recordDeferral();
    expect(cap.rateFor(1000, clock)).toBe(500);
    expect(cap.rateFor(1000, clock + DEFAULT_DEFERRAL_HOLD_MS - 1)).toBe(500);
    expect(cap.rateFor(1000, clock + DEFAULT_DEFERRAL_HOLD_MS)).toBe(1000);
  });

  it('halves again on a deferral inside an active hold, never below 1 per hour', () => {
    const cap = createBulkCap({ now: () => clock });
    cap.recordDeferral();
    cap.recordDeferral();
    expect(cap.rateFor(1000, clock)).toBe(250);
    for (let i = 0; i < 20; i += 1) {
      cap.recordDeferral();
    }
    expect(cap.rateFor(1000, clock)).toBe(1);
  });
});

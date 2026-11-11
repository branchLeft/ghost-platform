import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const NOW = START + DAY;

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

  it('matches every line of a multi-line reply that carries the code after the status code', () => {
    const response = '421-4.7.28 Our system has detected an unusual rate of\n421 4.7.28 mail.';
    expect(isBulkDeferral(Object.assign(new Error('x'), { response }))).toBe(true);
  });

  it('does not match 4.7.28 sitting anywhere but the status code position', () => {
    for (const response of [
      '550 5.1.1 mailbox user-4.7.28@example.com unknown',
      '550 5.7.1 rejected, see https://help.example/4.7.28',
      '250 2.0.0 queued as 4.7.28',
      '421 4.3.2 shutting down; ref 4.7.28',
    ]) {
      expect(isBulkDeferral(Object.assign(new Error(response), { response }))).toBe(false);
    }
  });

  it('does not match 4.7.28 under a permanent 5xx status code', () => {
    const response = '550 4.7.28 refused';
    expect(isBulkDeferral(Object.assign(new Error('x'), { response }))).toBe(false);
  });

  it('does not match 4.7.650 away from the status code position', () => {
    const response = '451 4.4.1 try later, ticket 4.7.650';
    expect(
      isBulkDeferral(Object.assign(new Error(response), { responseCode: 451, response }))
    ).toBe(false);
  });
});

describe('parseRampSchedule', () => {
  it('accepts a well-formed schedule', () => {
    expect(parseRampSchedule(goodRamp, NOW).steps).toHaveLength(2);
  });

  it('refuses a missing or unparseable startedAt', () => {
    expect(() => parseRampSchedule({ ...goodRamp, startedAt: 'soon' }, NOW)).toThrow(/startedAt/);
  });

  it.each([
    ['a bare number', '11'],
    ['a bare year', '2020'],
    ['a date with no time or zone', '2026-11-10'],
    ['a time with no zone', '2026-11-10T00:00:00'],
    ['a non-ISO date', 'Nov 10 2026'],
    ['a day the month does not have', '2026-02-31T00:00:00Z'],
    ['an hour past 24', '2026-11-10T25:00:00Z'],
  ])('refuses a startedAt that is %s, which Date.parse alone would accept', (_name, startedAt) => {
    expect(() => parseRampSchedule({ ...goodRamp, startedAt }, NOW)).toThrow(/startedAt/);
  });

  it('refuses a startedAt in the future beyond a few minutes of clock skew', () => {
    const future = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(() => parseRampSchedule({ ...goodRamp, startedAt: future }, NOW)).toThrow(/future/);
    const skewed = new Date(NOW + 60 * 1000).toISOString();
    expect(parseRampSchedule({ ...goodRamp, startedAt: skewed }, NOW).startedAt).toBe(skewed);
  });

  it('refuses a startedAt older than the sane bound, which would put the ramp at its last step', () => {
    const ancient = new Date(NOW - 400 * DAY).toISOString();
    expect(() => parseRampSchedule({ ...goodRamp, startedAt: ancient }, NOW)).toThrow(/older/);
    const recent = new Date(NOW - 300 * DAY).toISOString();
    expect(parseRampSchedule({ ...goodRamp, startedAt: recent }, NOW).startedAt).toBe(recent);
  });

  it('accepts an offset ISO instant', () => {
    const startedAt = '2026-11-10T12:00:00+01:00';
    expect(parseRampSchedule({ ...goodRamp, startedAt }, NOW).startedAt).toBe(startedAt);
  });

  it('refuses an empty step list', () => {
    expect(() => parseRampSchedule({ ...goodRamp, steps: [] }, NOW)).toThrow(/non-empty/);
  });

  it('refuses a first step that does not start at day 0', () => {
    expect(() =>
      parseRampSchedule({ ...goodRamp, steps: [{ afterDays: 1, messagesPerHour: 20 }] }, NOW)
    ).toThrow(/afterDays 0/);
  });

  it('refuses steps out of order or repeated', () => {
    expect(() =>
      parseRampSchedule(
        {
          ...goodRamp,
          steps: [
            { afterDays: 0, messagesPerHour: 20 },
            { afterDays: 0, messagesPerHour: 40 },
          ],
        },
        NOW
      )
    ).toThrow(/ascending/);
  });

  it('refuses a fractional or zero rate', () => {
    expect(() =>
      parseRampSchedule({ ...goodRamp, steps: [{ afterDays: 0, messagesPerHour: 0 }] }, NOW)
    ).toThrow(/messagesPerHour/);
    expect(() =>
      parseRampSchedule({ ...goodRamp, steps: [{ afterDays: 0, messagesPerHour: 2.5 }] }, NOW)
    ).toThrow(/messagesPerHour/);
  });
});

describe('rampRateAt', () => {
  const schedule = parseRampSchedule(goodRamp, NOW);

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

  it.each(['11', '2020'])(
    'a ramp file whose startedAt is %s never reaches its last step: bulk stays at 1 per hour',
    (startedAt) => {
      writeFileSync(rampPath, JSON.stringify({ ...goodRamp, startedAt }));
      const cap = createBulkCap({ rampPath, now: () => clock });
      expect(cap.rateFor(1000, clock)).toBe(1);
    }
  );

  it('an invalid rewrite of a good ramp keeps the last good schedule, never its last step', () => {
    writeFileSync(rampPath, JSON.stringify(goodRamp));
    const cap = createBulkCap({ rampPath, now: () => clock });
    expect(cap.rateFor(1000, clock)).toBe(20);
    writeFileSync(rampPath, JSON.stringify({ ...goodRamp, startedAt: '2020' }));
    expect(cap.rateFor(1000, clock)).toBe(20);
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
  describe('the deferral hold survives a restart', () => {
    let statePath: string;
    const errors: string[] = [];

    beforeEach(() => {
      statePath = join(dir, 'state', 'bulk-deferral.json');
      errors.length = 0;
    });

    function capAt(path: string) {
      return createBulkCap({
        now: () => clock,
        deferralStatePath: path,
        onStateError: (error) => errors.push(error.message),
      });
    }

    it('a new cap on the same file still holds the halved rate during the hold', () => {
      capAt(statePath).recordDeferral();
      const restarted = capAt(statePath);
      expect(restarted.rateFor(1000, clock)).toBe(500);
      expect(restarted.rateFor(1000, clock + DEFAULT_DEFERRAL_HOLD_MS - 1)).toBe(500);
      expect(restarted.rateFor(1000, clock + DEFAULT_DEFERRAL_HOLD_MS)).toBe(1000);
    });

    it('keeps the number of halvings, so a second deferral inside the hold is not forgotten', () => {
      const first = capAt(statePath);
      first.recordDeferral();
      first.recordDeferral();
      expect(capAt(statePath).rateFor(1000, clock)).toBe(250);
    });

    it('a restart after the hold has passed starts at the full rate', () => {
      capAt(statePath).recordDeferral();
      clock += DEFAULT_DEFERRAL_HOLD_MS + 1;
      expect(capAt(statePath).rateFor(1000, clock)).toBe(1000);
    });

    it('a missing file means no hold and no error', () => {
      expect(capAt(statePath).rateFor(1000, clock)).toBe(1000);
      expect(errors).toEqual([]);
    });

    it('leaves no temp file behind after a write', () => {
      capAt(statePath).recordDeferral();
      expect(readdirSync(join(dir, 'state'))).toEqual(['bulk-deferral.json']);
    });

    it.each([
      ['not JSON', '{nope'],
      ['the wrong shape', JSON.stringify({ version: 9 })],
      ['a non-finite hold end', '{"version":1,"halvings":1,"reducedUntilMs":1e999}'],
      ['a fractional halving count', '{"version":1,"halvings":1.5,"reducedUntilMs":1}'],
    ])(
      'a state file that is %s fails closed: a fresh hold, reported, never full rate',
      (_n, body) => {
        mkdirSync(join(dir, 'state'), { recursive: true });
        writeFileSync(statePath, body);
        const cap = capAt(statePath);
        expect(cap.rateFor(1000, clock)).toBe(500);
        expect(cap.rateFor(1000, clock + DEFAULT_DEFERRAL_HOLD_MS)).toBe(1000);
        expect(errors).toHaveLength(1);
      }
    );

    it('a hold end far in the future is clamped to one hold period', () => {
      mkdirSync(join(dir, 'state'), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify({ version: 1, halvings: 1, reducedUntilMs: clock + 1000 * DAY })
      );
      const cap = capAt(statePath);
      expect(cap.rateFor(1000, clock)).toBe(500);
      expect(cap.rateFor(1000, clock + DEFAULT_DEFERRAL_HOLD_MS)).toBe(1000);
    });

    it('an unwritable state path is reported and the in-memory hold still applies', () => {
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'a file where a directory is needed');
      const cap = capAt(join(blocker, 'bulk-deferral.json'));
      cap.recordDeferral();
      expect(cap.rateFor(1000, clock)).toBe(500);
      expect(errors).toHaveLength(1);
    });
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSweegoUsage,
  utcMonthOf,
  type SweegoUsage,
  type UsageReason,
} from '../../src/sweegoUsage.js';

/**
 * The counter is driven by a fake clock and never sleeps. See
 * ../../README.md#sweegousage-createsweegousage.
 */

function at(iso: string): number {
  return Date.parse(iso);
}

describe('the sweego usage counter', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let allowances: Record<string, number | undefined>;
  let reasons: UsageReason[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-usage-'));
    statePath = join(dir, 'usage.json');
    clock = at('2026-11-15T12:00:00.000Z');
    allowances = { 'tenant-a': 3, 'tenant-b': 3 };
    reasons = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(options: { accountCap?: number; path?: string } = {}): SweegoUsage {
    return createSweegoUsage({
      statePath: options.path ?? statePath,
      accountCap: options.accountCap ?? 100,
      allowanceOf: (id) => allowances[id],
      now: () => clock,
      onReason: (reason) => reasons.push(reason),
    });
  }

  function send(usage: SweegoUsage, tenant: string, times = 1): void {
    for (let n = 0; n < times; n += 1) {
      usage.begin(tenant).settle(true);
    }
  }

  const usedBy = (usage: SweegoUsage, tenant: string): number | undefined =>
    usage.tenantLatchState().find((row) => row.tenant === tenant)?.used;

  describe('counting', () => {
    it('counts accepted messages per tenant and in total, and nothing else', () => {
      const usage = open();
      send(usage, 'tenant-a', 2);
      send(usage, 'tenant-b');
      usage.begin('tenant-a').settle(false);
      expect(usedBy(usage, 'tenant-a')).toBe(2);
      expect(usedBy(usage, 'tenant-b')).toBe(1);
      expect(usage.accountState()).toMatchObject({ month: '2026-11', total: 3, degraded: false });
    });

    it('counts an attempt once however often it is settled', () => {
      const usage = open();
      const slot = usage.begin('tenant-a');
      slot.settle(true);
      slot.settle(true);
      slot.settle(false);
      expect(usedBy(usage, 'tenant-a')).toBe(1);
    });

    it('is not latched and not at the cap while a tenant is under its allowance', () => {
      const usage = open();
      send(usage, 'tenant-a', 2);
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountCapReached()).toBe(false);
      expect(reasons).toEqual([]);
    });
  });

  describe('surviving a restart', () => {
    it('keeps each tenant count and the total across a restart in the same month', () => {
      const first = open();
      send(first, 'tenant-a', 2);
      send(first, 'tenant-b');
      const second = open();
      expect(usedBy(second, 'tenant-a')).toBe(2);
      expect(usedBy(second, 'tenant-b')).toBe(1);
      expect(second.accountState().total).toBe(3);
      send(second, 'tenant-a');
      expect(second.allowanceReached('tenant-a')).toBe(true);
    });

    it('keeps a latch across a restart', () => {
      send(open(), 'tenant-a', 3);
      const restarted = open();
      expect(restarted.allowanceReached('tenant-a')).toBe(true);
      expect(restarted.allowanceReached('tenant-b')).toBe(false);
    });

    it('starts empty, not degraded, when there is no state file yet', () => {
      const usage = open();
      expect(usage.tenantLatchState()).toEqual([]);
      expect(usage.accountState()).toMatchObject({ total: 0, degraded: false });
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(reasons).toEqual([]);
    });

    it('writes only counts: no message, address or subject can reach the file', () => {
      send(open(), 'tenant-a', 2);
      const body = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['degraded', 'month', 'tenants', 'version']);
    });
  });

  describe('the latch at 100 percent of the allowance', () => {
    it('latches the tenant on the message that reaches the allowance, and only that tenant', () => {
      const usage = open();
      send(usage, 'tenant-a', 2);
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      send(usage, 'tenant-a');
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.allowanceReached('tenant-b')).toBe(false);
      expect(reasons.filter((r) => r === 'tenant-latched')).toHaveLength(1);
    });

    it('holds the latch until the month ends, even if the allowance is raised meanwhile', () => {
      const usage = open();
      send(usage, 'tenant-a', 3);
      allowances['tenant-a'] = 1000;
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(open().allowanceReached('tenant-a')).toBe(true);
    });

    it('counts an attempt in flight against the allowance, and gives it back if the attempt fails', () => {
      const usage = open();
      send(usage, 'tenant-a', 2);
      const inFlight = usage.begin('tenant-a');
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      inFlight.settle(false);
      expect(usage.allowanceReached('tenant-a')).toBe(false);
    });

    it('reports a tenant with no allowance on its route as latched', () => {
      allowances['tenant-c'] = undefined;
      const usage = open();
      expect(usage.allowanceReached('tenant-c')).toBe(true);
      expect(reasons).toContain('allowance-unknown');
    });

    it('lists each tenant with its use, its allowance and whether it is latched', () => {
      const usage = open();
      send(usage, 'tenant-a', 3);
      send(usage, 'tenant-b');
      expect(usage.tenantLatchState()).toEqual([
        { tenant: 'tenant-a', used: 3, allowance: 3, latched: true },
        { tenant: 'tenant-b', used: 1, allowance: 3, latched: false },
      ]);
    });
  });

  describe('the account-wide cap', () => {
    it('latches every tenant when the total across tenants reaches the cap', () => {
      allowances = { 'tenant-a': 50, 'tenant-b': 50 };
      const usage = open({ accountCap: 4 });
      send(usage, 'tenant-a', 2);
      send(usage, 'tenant-b');
      expect(usage.accountCapReached()).toBe(false);
      send(usage, 'tenant-b');
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.tenantLatchState().map((row) => row.latched)).toEqual([true, true]);
      expect(usage.accountState()).toMatchObject({ total: 4, accountCap: 4, capReached: true });
      expect(reasons.filter((r) => r === 'account-cap-reached')).toHaveLength(1);
    });

    it('holds the total inside the cap when attempts are in flight together', () => {
      allowances = { 'tenant-a': 50, 'tenant-b': 50 };
      const usage = open({ accountCap: 2 });
      send(usage, 'tenant-a');
      const a = usage.begin('tenant-a');
      expect(usage.accountCapReached()).toBe(true);
      a.settle(false);
      expect(usage.accountCapReached()).toBe(false);
    });

    it('survives a restart and lifts when the owner raises the cap', () => {
      allowances = { 'tenant-a': 50 };
      send(open({ accountCap: 2 }), 'tenant-a', 2);
      expect(open({ accountCap: 2 }).accountCapReached()).toBe(true);
      expect(open({ accountCap: 5 }).accountCapReached()).toBe(false);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses a cap of %s: there is no unlimited',
      (accountCap) => {
        expect(() => open({ accountCap })).toThrow(/positive integer/);
      }
    );
  });

  describe('the UTC calendar month', () => {
    it('names the month from the UTC instant, not the local one', () => {
      expect(utcMonthOf(at('2026-11-30T23:59:59.999Z'))).toBe('2026-11');
      expect(utcMonthOf(at('2026-12-01T00:00:00.000Z'))).toBe('2026-12');
      expect(utcMonthOf(at('2026-12-01T00:30:00.000+01:00'))).toBe('2026-11');
    });

    it('rolls over exactly at 00:00:00 UTC: 23:59:59 is still the old month', () => {
      clock = at('2026-11-30T23:00:00.000Z');
      const usage = open();
      send(usage, 'tenant-a', 3);
      expect(usage.allowanceReached('tenant-a')).toBe(true);

      clock = at('2026-11-30T23:59:59.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.accountState().month).toBe('2026-11');
      expect(reasons).not.toContain('month-rolled');

      clock = at('2026-12-01T00:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountState()).toMatchObject({ month: '2026-12', total: 0 });
      expect(usage.tenantLatchState()).toEqual([]);
      expect(reasons.filter((r) => r === 'month-rolled')).toHaveLength(1);
    });

    it('counts a message accepted after the boundary against the new month', () => {
      clock = at('2026-11-30T23:59:59.000Z');
      const usage = open();
      send(usage, 'tenant-a', 3);
      clock = at('2026-12-01T00:00:00.000Z');
      send(usage, 'tenant-a');
      expect(usedBy(usage, 'tenant-a')).toBe(1);
      expect(usage.allowanceReached('tenant-a')).toBe(false);
    });

    it('rolls at the year boundary', () => {
      clock = at('2026-12-31T23:59:59.000Z');
      const usage = open();
      send(usage, 'tenant-a', 3);
      clock = at('2027-01-01T00:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountState().month).toBe('2027-01');
    });

    it('keeps February 29 in February in a leap year, and rolls only on March 1', () => {
      clock = at('2028-02-28T23:59:59.000Z');
      const usage = open();
      send(usage, 'tenant-a', 3);

      clock = at('2028-02-29T00:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.accountState().month).toBe('2028-02');

      clock = at('2028-02-29T23:59:59.999Z');
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(reasons).not.toContain('month-rolled');

      clock = at('2028-03-01T00:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountState().month).toBe('2028-03');
    });

    it('rolls on March 1 in a common year, with no phantom February 29', () => {
      clock = at('2027-02-28T23:59:59.000Z');
      const usage = open();
      send(usage, 'tenant-a', 3);
      clock = at('2027-03-01T00:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountState().month).toBe('2027-03');
    });

    it('rolls an idle process on its next question, after any length of silence', () => {
      const usage = open();
      send(usage, 'tenant-a', 3);
      clock = at('2027-03-09T08:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountState().month).toBe('2027-03');
    });

    it('rolls a restart that comes after the month ended, and persists the new month', () => {
      send(open(), 'tenant-a', 3);
      clock = at('2026-12-02T09:00:00.000Z');
      const restarted = open();
      expect(restarted.allowanceReached('tenant-a')).toBe(false);
      expect(restarted.accountState()).toMatchObject({ month: '2026-12', total: 0 });
      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { month: string };
      expect(onDisk.month).toBe('2026-12');
    });

    it('keeps the counters of a restart in the same month, mid-month', () => {
      clock = at('2026-11-10T00:00:00.000Z');
      send(open(), 'tenant-a', 2);
      clock = at('2026-11-29T22:00:00.000Z');
      const restarted = open();
      expect(usedBy(restarted, 'tenant-a')).toBe(2);
      expect(reasons).not.toContain('month-rolled');
    });

    it('does not reset the counters when the clock reads an earlier month than the stored one', () => {
      clock = at('2026-12-02T00:00:00.000Z');
      send(open(), 'tenant-a', 3);
      clock = at('2026-11-30T00:00:00.000Z');
      const usage = open();
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.accountState().month).toBe('2026-12');
      expect(reasons.filter((r) => r === 'clock-behind-state')).toHaveLength(1);
    });
  });

  describe('when usage cannot be known it fails toward the latch, never toward unlimited Sweego', () => {
    function expectClosed(usage: SweegoUsage): void {
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.allowanceReached('tenant-b')).toBe(true);
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.tenantLatchState()).toEqual([]);
      expect(usage.accountState().degraded).toBe(true);
    }

    it('treats a state file that is not JSON as corrupt, and says so in a counted reason', () => {
      writeFileSync(statePath, '{"version":1,"month":"2026-11","degr');
      const usage = open();
      expectClosed(usage);
      expect(usage.reasons()).toEqual({ 'state-corrupt': 1 });
      expect(reasons).toEqual(['state-corrupt']);
    });

    it.each([
      ['an unknown version', { version: 2, month: '2026-11', degraded: false, tenants: {} }],
      [
        'a month that is not a month',
        { version: 1, month: '2026-13', degraded: false, tenants: {} },
      ],
      ['no month', { version: 1, degraded: false, tenants: {} }],
      ['a missing degraded flag', { version: 1, month: '2026-11', tenants: {} }],
      ['tenants as an array', { version: 1, month: '2026-11', degraded: false, tenants: [] }],
      [
        'a negative count',
        {
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: { a: { used: -1, latched: false } },
        },
      ],
      [
        'a fractional count',
        {
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: { a: { used: 1.5, latched: false } },
        },
      ],
      [
        'a string count',
        {
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: { a: { used: '1', latched: false } },
        },
      ],
      ['null', null],
      ['a bare number', 7],
    ])('treats a state file holding %s as corrupt', (_label, body) => {
      writeFileSync(statePath, JSON.stringify(body));
      const usage = open();
      expectClosed(usage);
      expect(usage.reasons()['state-corrupt']).toBe(1);
    });

    it('treats a state file that exists but cannot be read as unreadable', () => {
      mkdirSync(statePath);
      const usage = open();
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.reasons()['state-unreadable']).toBe(1);
    });

    it('stays closed across a restart in the same month, because the degraded flag is written down', () => {
      writeFileSync(statePath, 'not json');
      open();
      const restarted = open();
      expectClosed(restarted);
      expect(restarted.reasons()).toEqual({});
    });

    it('opens again at the next month, with every counter at zero', () => {
      writeFileSync(statePath, 'not json');
      const usage = open();
      expectClosed(usage);
      clock = at('2026-12-01T00:00:00.000Z');
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.accountCapReached()).toBe(false);
      expect(usage.accountState()).toMatchObject({ month: '2026-12', degraded: false });
    });

    it('goes closed when the state cannot be written, counts the message, and opens when a write succeeds', () => {
      // Opened while the path is free, then a plain file takes the place of its directory.
      const blocked = open({ path: join(dir, 'blocker', 'usage.json') });
      writeFileSync(join(dir, 'blocker'), 'a file where a directory is needed');
      send(blocked, 'tenant-a');
      expect(blocked.reasons()['state-write-failed']).toBeGreaterThanOrEqual(1);
      expect(blocked.allowanceReached('tenant-a')).toBe(true);
      expect(blocked.accountCapReached()).toBe(true);

      rmSync(join(dir, 'blocker'));
      expect(blocked.allowanceReached('tenant-a')).toBe(false);
      expect(usedBy(blocked, 'tenant-a')).toBe(1);
      expect(usedBy(open({ path: join(dir, 'blocker', 'usage.json') }), 'tenant-a')).toBe(1);
    });
  });

  describe('what it exposes', () => {
    it('names no tenant, address or subject in any reason it counts or reports', () => {
      allowances = { 'tenant-secret-name': 1 };
      const usage = open({ accountCap: 1 });
      send(usage, 'tenant-secret-name');
      clock = at('2026-12-01T00:00:00.000Z');
      usage.allowanceReached('tenant-secret-name');
      writeFileSync(statePath, 'garbage');
      open();
      const everything = JSON.stringify({ counts: usage.reasons(), heard: reasons });
      expect(everything).not.toContain('tenant-secret-name');
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(reason).toMatch(/^[a-z]+(-[a-z]+)*$/);
      }
    });
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  function open(
    options: {
      accountCap?: number;
      path?: string;
      newsletterCap?: number;
      suspension?: { suspended(): boolean };
    } = {}
  ): SweegoUsage {
    return createSweegoUsage({
      statePath: options.path ?? statePath,
      accountCap: options.accountCap ?? 100,
      ...(options.newsletterCap === undefined ? {} : { newsletterCap: options.newsletterCap }),
      ...(options.suspension ? { suspension: options.suspension } : {}),
      allowanceOf: (id) => allowances[id],
      now: () => clock,
      onReason: (reason) => reasons.push(reason),
    });
  }

  function send(usage: SweegoUsage, tenant: string, times = 1): void {
    for (let n = 0; n < times; n += 1) {
      usage.begin(tenant)!.settle(true);
    }
  }

  const usedBy = (usage: SweegoUsage, tenant: string): number | undefined =>
    usage.tenantLatchState().find((row) => row.tenant === tenant)?.used;

  describe('counting', () => {
    it('counts accepted messages per tenant and in total, and nothing else', () => {
      const usage = open();
      send(usage, 'tenant-a', 2);
      send(usage, 'tenant-b');
      usage.begin('tenant-a')!.settle(false);
      expect(usedBy(usage, 'tenant-a')).toBe(2);
      expect(usedBy(usage, 'tenant-b')).toBe(1);
      expect(usage.accountState()).toMatchObject({ month: '2026-11', total: 3, degraded: false });
    });

    it('counts an attempt once however often it is settled', () => {
      const usage = open();
      const slot = usage.begin('tenant-a')!;
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
      const inFlight = usage.begin('tenant-a')!;
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
      const a = usage.begin('tenant-a')!;
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
      // The place is reserved while the path is free, then a plain file takes the place of its directory.
      const blocked = open({ path: join(dir, 'blocker', 'usage.json') });
      const slot = blocked.begin('tenant-a')!;
      rmSync(join(dir, 'blocker'), { recursive: true });
      writeFileSync(join(dir, 'blocker'), 'a file where a directory is needed');
      slot.settle(true);
      expect(blocked.reasons()['state-write-failed']).toBeGreaterThanOrEqual(1);
      expect(blocked.allowanceReached('tenant-a')).toBe(true);
      expect(blocked.accountCapReached()).toBe(true);

      rmSync(join(dir, 'blocker'));
      expect(blocked.allowanceReached('tenant-a')).toBe(false);
      expect(usedBy(blocked, 'tenant-a')).toBe(1);
      expect(usedBy(open({ path: join(dir, 'blocker', 'usage.json') }), 'tenant-a')).toBe(1);
    });
  });

  describe('a state file that has vanished', () => {
    const markerOf = (): string => `${statePath}.initialised`;

    it('writes a marker beside the state file on the first successful save, and not before', () => {
      const usage = open();
      expect(existsSync(markerOf())).toBe(false);
      send(usage, 'tenant-a');
      expect(existsSync(markerOf())).toBe(true);
    });

    it('latches every send toward mx1 when the file is gone but the marker is there, and counts the reason', () => {
      send(open(), 'tenant-a', 2);
      rmSync(statePath);
      reasons.length = 0;
      const usage = open();
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.allowanceReached('tenant-b')).toBe(true);
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.reasons()).toEqual({ 'state-vanished': 1 });
      expect(reasons).toEqual(['state-vanished']);
    });

    it('stays latched across a restart and a month change until the owner deletes the marker', () => {
      send(open(), 'tenant-a');
      rmSync(statePath);
      open();
      expect(open().accountCapReached()).toBe(true);
      clock = at('2026-12-01T00:00:00.000Z');
      const later = open();
      expect(later.accountCapReached()).toBe(true);
      expect(later.allowanceReached('tenant-a')).toBe(true);
      rmSync(markerOf());
      const cleared = open();
      expect(cleared.accountCapReached()).toBe(false);
      expect(cleared.allowanceReached('tenant-a')).toBe(false);
      send(cleared, 'tenant-a');
      expect(open().accountCapReached()).toBe(false);
    });

    it('is a first run, counters at zero, when the owner has deleted the marker and the file is gone too', () => {
      send(open(), 'tenant-a', 2);
      rmSync(statePath);
      rmSync(markerOf());
      reasons.length = 0;
      const usage = open();
      expect(usage.accountCapReached()).toBe(false);
      expect(usage.accountState().total).toBe(0);
      expect(reasons).toEqual([]);
    });

    it('reads a file with no marker as an upgrade, not a loss, and writes the marker', () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: { 'tenant-a': { used: 2, latched: false } },
        })
      );
      const usage = open();
      expect(usedBy(usage, 'tenant-a')).toBe(2);
      expect(usage.accountCapReached()).toBe(false);
      expect(existsSync(markerOf())).toBe(true);
      rmSync(statePath);
      expect(open().accountCapReached()).toBe(true);
    });

    it('goes closed, as a failed write, when the marker cannot be written', () => {
      const usage = open();
      mkdirSync(markerOf());
      expect(usage.begin('tenant-a')).toBeUndefined();
      expect(usage.reasons()['state-write-failed']).toBeGreaterThanOrEqual(1);
      expect(usage.accountCapReached()).toBe(true);
      rmSync(markerOf(), { recursive: true });
      expect(usage.accountCapReached()).toBe(false);
      expect(existsSync(markerOf())).toBe(true);
    });

    it('logs a reason that names no tenant, recipient or subject', () => {
      allowances = { 'tenant-secret-name': 5 };
      send(open(), 'tenant-secret-name');
      rmSync(statePath);
      reasons.length = 0;
      const usage = open();
      expect(JSON.stringify({ counts: usage.reasons(), heard: reasons })).not.toContain(
        'tenant-secret-name'
      );
      expect(reasons).toEqual(['state-vanished']);
    });
  });

  describe('an attempt that may have been taken', () => {
    it('counts an ambiguous end against the tenant and the total', () => {
      const usage = open();
      usage.begin('tenant-a', 'm1')!.ambiguous();
      expect(usedBy(usage, 'tenant-a')).toBe(1);
      expect(usage.accountState().total).toBe(1);
    });

    it('counts the message once when a later attempt for it is accepted', () => {
      const usage = open();
      usage.begin('tenant-a', 'm1')!.ambiguous();
      usage.begin('tenant-a', 'm1')!.settle(true);
      expect(usedBy(usage, 'tenant-a')).toBe(1);
      expect(usage.accountState().total).toBe(1);
    });

    it('counts the message once across a restart', () => {
      open().begin('tenant-a', 'm1')!.ambiguous();
      const restarted = open();
      restarted.begin('tenant-a', 'm1')!.settle(true);
      restarted.begin('tenant-a', 'm1')!.ambiguous();
      expect(usedBy(restarted, 'tenant-a')).toBe(1);
    });

    it('counts two different messages separately', () => {
      const usage = open();
      usage.begin('tenant-a', 'm1')!.ambiguous();
      usage.begin('tenant-a', 'm2')!.ambiguous();
      expect(usedBy(usage, 'tenant-a')).toBe(2);
    });

    it('latches the tenant when an ambiguous attempt reaches its allowance', () => {
      const usage = open();
      send(usage, 'tenant-a', 2);
      usage.begin('tenant-a', 'm1')!.ambiguous();
      expect(usage.allowanceReached('tenant-a')).toBe(true);
    });

    it('counts in the same reservation as any other attempt: it holds a place until it ends', () => {
      const usage = open({ accountCap: 1 });
      const slot = usage.begin('tenant-a', 'm1')!;
      expect(usage.accountCapReached()).toBe(true);
      slot.ambiguous();
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.accountState().total).toBe(1);
    });

    it('settles once: an ambiguous end after a settle, or the other way round, changes nothing', () => {
      const usage = open();
      const first = usage.begin('tenant-a', 'm1')!;
      first.settle(false);
      first.ambiguous();
      const second = usage.begin('tenant-a', 'm2')!;
      second.ambiguous();
      second.settle(true);
      second.ambiguous();
      expect(usedBy(usage, 'tenant-a')).toBe(1);
    });

    it('forgets the counted messages at a month change, so one tried again in the new month counts there', () => {
      const usage = open();
      usage.begin('tenant-a', 'm1')!.ambiguous();
      clock = at('2026-12-01T00:00:00.000Z');
      usage.begin('tenant-a', 'm1')!.settle(true);
      expect(usedBy(usage, 'tenant-a')).toBe(1);
      expect(usage.accountState()).toMatchObject({ month: '2026-12', total: 1 });
    });

    it('writes the counted messages as digests, never as ids', () => {
      open().begin('tenant-a', 'message-id-123')!.ambiguous();
      expect(readFileSync(statePath, 'utf8')).not.toContain('message-id-123');
    });
  });

  describe('the newsletter threshold', () => {
    it('is not reached, and not exposed, while no threshold is set', () => {
      const usage = open({ accountCap: 5 });
      send(usage, 'tenant-a', 2);
      expect(usage.newsletterThresholdReached()).toBe(false);
      expect(usage.accountState()).toMatchObject({
        newsletterCap: undefined,
        newsletterThresholdReached: false,
        suspended: false,
      });
    });

    it('is reached by the message that reaches it, for every tenant, and the account cap is not', () => {
      allowances = { 'tenant-a': 50, 'tenant-b': 50 };
      const usage = open({ accountCap: 10, newsletterCap: 4 });
      send(usage, 'tenant-a', 3);
      expect(usage.newsletterThresholdReached()).toBe(false);
      send(usage, 'tenant-b');
      expect(usage.newsletterThresholdReached()).toBe(true);
      expect(usage.accountCapReached()).toBe(false);
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.allowanceReached('tenant-b')).toBe(false);
      expect(usage.accountState()).toMatchObject({
        total: 4,
        newsletterCap: 4,
        newsletterThresholdReached: true,
        capReached: false,
      });
      expect(usage.reasons()['newsletter-threshold-reached']).toBe(1);
    });

    it('counts places in flight, as the account cap does', () => {
      const usage = open({ accountCap: 10, newsletterCap: 2 });
      const first = usage.begin('tenant-a')!;
      usage.begin('tenant-a')!;
      expect(usage.newsletterThresholdReached()).toBe(true);
      first.settle(false);
      expect(usage.newsletterThresholdReached()).toBe(false);
    });

    it('survives a restart', () => {
      send(open({ accountCap: 10, newsletterCap: 2 }), 'tenant-a', 2);
      expect(open({ accountCap: 10, newsletterCap: 2 }).newsletterThresholdReached()).toBe(true);
    });

    it('starts again at the first instant of the next UTC month', () => {
      const usage = open({ accountCap: 10, newsletterCap: 2 });
      send(usage, 'tenant-a', 2);
      expect(usage.newsletterThresholdReached()).toBe(true);
      clock = at('2026-12-01T00:00:00.000Z');
      expect(usage.newsletterThresholdReached()).toBe(false);
      expect(usage.accountState()).toMatchObject({
        month: '2026-12',
        total: 0,
        newsletterThresholdReached: false,
      });
    });

    it('reads unknown usage as reached', () => {
      writeFileSync(statePath, 'garbage');
      expect(open({ accountCap: 10, newsletterCap: 2 }).newsletterThresholdReached()).toBe(true);
    });

    it.each([
      ['equal to the account cap', 10, 10],
      ['above the account cap', 11, 10],
      ['zero', 0, 10],
      ['negative', -1, 10],
      ['not an integer', 1.5, 10],
    ])('refuses a threshold that is %s', (_label, newsletterCap, accountCap) => {
      expect(() => open({ accountCap, newsletterCap })).toThrow(/newsletter cap/);
    });

    it('accepts a threshold one below the account cap', () => {
      expect(() => open({ accountCap: 10, newsletterCap: 9 })).not.toThrow();
    });
  });

  describe('the suspension fact', () => {
    it('reports what the suspension latch says, live', () => {
      let suspended = false;
      const usage = open({ suspension: { suspended: () => suspended } });
      expect(usage.suspended()).toBe(false);
      expect(usage.accountState().suspended).toBe(false);
      suspended = true;
      expect(usage.suspended()).toBe(true);
      expect(usage.accountState().suspended).toBe(true);
    });

    it('is false with no suspension latch', () => {
      expect(open().suspended()).toBe(false);
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

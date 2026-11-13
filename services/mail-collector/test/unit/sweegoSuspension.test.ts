import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateWitness, type StateWitness } from '../../src/stateWitness.js';
import {
  SUSPENSION_WINDOW_MS,
  createSweegoSuspension,
  type SuspensionReason,
  type SweegoSuspension,
} from '../../src/sweegoSuspension.js';
import { createSweegoUsage } from '../../src/sweegoUsage.js';

/**
 * The suspension latch is driven by a fake clock and never sleeps. See
 * ../../README.md#sweegosuspension-createsweegosuspension.
 */

const MINUTE = 60_000;

describe('the sweego suspension latch', () => {
  let base: string;
  let stateDir: string;
  let witnessDir: string;
  let statePath: string;
  let ownerFilePath: string;
  let clock: number;
  let reasons: SuspensionReason[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'collector-suspension-'));
    stateDir = join(base, 'state');
    witnessDir = join(base, 'witness');
    mkdirSync(stateDir);
    statePath = join(stateDir, 'suspension.json');
    ownerFilePath = join(stateDir, 'suspend');
    clock = Date.parse('2026-11-15T12:00:00.000Z');
    reasons = [];
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const markerOf = (): string => `${statePath}.initialised`;
  const mountKeyOf = (path: string): string => (path.startsWith(witnessDir) ? 'witness' : 'state');
  const witnessOf = (): StateWitness =>
    createStateWitness({ dir: witnessDir, statePaths: [statePath], mountKeyOf });

  function open(options: { witness?: StateWitness; owner?: boolean } = {}): SweegoSuspension {
    return createSweegoSuspension({
      statePath,
      ...(options.owner === false ? {} : { ownerFilePath }),
      now: () => clock,
      onReason: (reason) => reasons.push(reason),
      ...(options.witness ? { witness: options.witness } : {}),
    });
  }

  /** A run of auth refusals from the clock's present for `minutes`, one a minute. */
  function refuseFor(suspension: SweegoSuspension, minutes: number): void {
    for (let elapsed = 0; elapsed <= minutes; elapsed += 1) {
      suspension.recordRefusal('auth');
      if (elapsed < minutes) {
        clock += MINUTE;
      }
    }
  }

  describe('the run of refusals', () => {
    it('does not latch after 29 minutes of refusals', () => {
      const suspension = open();
      refuseFor(suspension, 29);
      expect(suspension.suspended()).toBe(false);
      expect(reasons).toEqual([]);
    });

    it('latches at 30 minutes of refusals', () => {
      const suspension = open();
      refuseFor(suspension, SUSPENSION_WINDOW_MS / MINUTE);
      expect(suspension.suspended()).toBe(true);
      expect(reasons).toEqual(['suspension-latched']);
    });

    it('counts credential refusals as well as authentication refusals', () => {
      const suspension = open();
      suspension.recordRefusal('credential');
      clock += SUSPENSION_WINDOW_MS;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(true);
    });

    it('ends the run at one acceptance: the next refusal starts a new run', () => {
      const suspension = open();
      refuseFor(suspension, 29);
      suspension.recordAcceptance();
      clock += MINUTE;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(false);
      // The new run began at that refusal, so 29 more minutes still do not latch.
      clock += 29 * MINUTE;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(false);
      clock += MINUTE;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(true);
    });

    it('is not started, extended or broken by any other failure reason', () => {
      const suspension = open();
      suspension.recordRefusal('unreachable');
      suspension.recordRefusal('deferred');
      suspension.recordRefusal('refused');
      suspension.recordRefusal('timeout');
      suspension.recordRefusal('ambiguous');
      suspension.recordRefusal('recipient-rejected');
      suspension.recordRefusal('unclassified');
      expect(suspension.state().runStart).toBeUndefined();
      suspension.recordRefusal('auth');
      clock += 20 * MINUTE;
      suspension.recordRefusal('unreachable');
      clock += 10 * MINUTE;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(true);
    });

    it('is not affected by a clock that steps backwards', () => {
      const suspension = open();
      suspension.recordRefusal('auth');
      clock -= 2 * 60 * MINUTE;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(false);
    });
  });

  describe('the persisted latch', () => {
    function latch(suspension: SweegoSuspension): void {
      refuseFor(suspension, 30);
    }

    it('writes the file and the marker when it latches, and nothing before', () => {
      const suspension = open();
      suspension.recordRefusal('auth');
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(markerOf())).toBe(false);
      latch(suspension);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        version: 1,
        suspended: true,
      });
      expect(existsSync(markerOf())).toBe(true);
    });

    it('survives a restart', () => {
      latch(open());
      expect(open().suspended()).toBe(true);
    });

    it('survives a UTC month roll: the usage counter rolling clears counts, not this', () => {
      const suspension = open();
      latch(suspension);
      const usage = createSweegoUsage({
        statePath: join(stateDir, 'usage.json'),
        accountCap: 10,
        allowanceOf: () => 5,
        now: () => clock,
        suspension,
      });
      clock = Date.parse('2026-12-01T00:00:01.000Z');
      expect(usage.accountState()).toMatchObject({ month: '2026-12', suspended: true });
      expect(suspension.suspended()).toBe(true);
      expect(open().suspended()).toBe(true);
      clock = Date.parse('2027-03-01T00:00:01.000Z');
      expect(open().suspended()).toBe(true);
    });

    it('clears only when the owner deletes the marker', () => {
      latch(open());
      rmSync(markerOf());
      const restarted = open();
      expect(restarted.suspended()).toBe(false);
      expect(reasons).toEqual(['suspension-latched', 'suspension-cleared']);
      // The clearing is written down: the marker is back, the file says not suspended.
      expect(existsSync(markerOf())).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ suspended: false });
      expect(open().suspended()).toBe(false);
    });

    it('does not clear when only the file is touched: a deleted file reads as vanished', () => {
      latch(open());
      rmSync(statePath);
      const restarted = open();
      expect(restarted.suspended()).toBe(true);
      expect(reasons).toContain('suspension-state-vanished');
    });

    it('can latch again after the owner cleared it', () => {
      latch(open());
      rmSync(markerOf());
      const cleared = open();
      expect(cleared.suspended()).toBe(false);
      latch(cleared);
      expect(cleared.suspended()).toBe(true);
      expect(open().suspended()).toBe(true);
    });

    it('reads a corrupt file as suspended, and writes that down', () => {
      latch(open());
      writeFileSync(statePath, '{not json');
      const restarted = open();
      expect(restarted.suspended()).toBe(true);
      expect(reasons).toContain('suspension-state-corrupt');
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ suspended: true });
    });

    it('reads an unreadable file as suspended', () => {
      latch(open());
      chmodSync(statePath, 0o000);
      try {
        const restarted = open();
        expect(restarted.suspended()).toBe(true);
        expect(reasons).toContain('suspension-state-unreadable');
      } finally {
        chmodSync(statePath, 0o600);
      }
    });

    it('holds the latch in memory when the write fails, and retries the write', () => {
      const suspension = open();
      // A directory where the file belongs makes every write fail.
      mkdirSync(statePath);
      latch(suspension);
      expect(suspension.suspended()).toBe(true);
      expect(reasons).toContain('suspension-write-failed');
      rmSync(statePath, { recursive: true });
      expect(suspension.suspended()).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ suspended: true });
    });
  });

  describe('with a witness on another mount', () => {
    it('latches a replaced state volume: file and marker gone, the witness remembers', () => {
      latch();
      rmSync(stateDir, { recursive: true, force: true });
      mkdirSync(stateDir);
      const restarted = open({ witness: witnessOf() });
      expect(restarted.suspended()).toBe(true);
      expect(reasons).toContain('suspension-witness-mismatch');
    });

    it('stays a first run when nothing was ever written', () => {
      expect(open({ witness: witnessOf() }).suspended()).toBe(false);
    });

    it('survives a restart with the witness, and clears when the marker is deleted', () => {
      latch();
      expect(open({ witness: witnessOf() }).suspended()).toBe(true);
      rmSync(markerOf());
      expect(open({ witness: witnessOf() }).suspended()).toBe(false);
    });

    function latch(): void {
      refuseFor(open({ witness: witnessOf() }), 30);
    }
  });

  describe('the owner file', () => {
    it('suspends sweego while it exists and not after it is removed', () => {
      const suspension = open();
      expect(suspension.suspended()).toBe(false);
      writeFileSync(ownerFilePath, '');
      expect(suspension.suspended()).toBe(true);
      expect(suspension.state()).toMatchObject({ suspended: true, ownerFile: true });
      rmSync(ownerFilePath);
      expect(suspension.suspended()).toBe(false);
    });

    it('is seen at start, and is counted once for each time it appears', () => {
      writeFileSync(ownerFilePath, '');
      const suspension = open();
      expect(suspension.suspended()).toBe(true);
      expect(suspension.suspended()).toBe(true);
      expect(reasons).toEqual(['suspension-owner-file']);
      rmSync(ownerFilePath);
      expect(suspension.suspended()).toBe(false);
      writeFileSync(ownerFilePath, '');
      expect(suspension.suspended()).toBe(true);
      expect(reasons).toEqual(['suspension-owner-file', 'suspension-owner-file']);
    });

    it('is independent of the refusal latch: removing the file does not clear a latch', () => {
      const suspension = open();
      refuseFor(suspension, 30);
      writeFileSync(ownerFilePath, '');
      rmSync(ownerFilePath);
      expect(suspension.suspended()).toBe(true);
    });

    it('reads a file it cannot tell apart from present as present', () => {
      // A path under a regular file cannot be stat-ed: ENOTDIR, not a plain absence.
      writeFileSync(join(stateDir, 'plain'), '');
      const suspension = createSweegoSuspension({
        statePath,
        ownerFilePath: join(stateDir, 'plain', 'suspend'),
        now: () => clock,
      });
      expect(suspension.suspended()).toBe(true);
    });

    it('is not consulted when no path is configured', () => {
      writeFileSync(ownerFilePath, '');
      expect(open({ owner: false }).suspended()).toBe(false);
    });
  });
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createStateWitness, mountIdFromInfo, type StateWitness } from '../../src/stateWitness.js';
import { createSweegoUsage, utcMonthOf, type SweegoUsage } from '../../src/sweegoUsage.js';

/**
 * Two directories in one temp folder stand in for two mounts: the injected
 * mount key tells them apart. See ../../README.md#state-witness.
 */

const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
  '31 22 8:2 / /var/state rw,relatime - ext4 /dev/sda2 rw',
  '32 22 8:2 /vol/witness /var/witness rw,relatime - ext4 /dev/sda2 rw',
  '33 31 8:3 / /var/state/with\\040space rw,relatime - ext4 /dev/sda3 rw',
].join('\n');

describe('mountIdFromInfo', () => {
  it('finds the longest mount point that holds the path', () => {
    expect(mountIdFromInfo(MOUNTINFO, '/var/state/usage.json')).toBe('31');
    expect(mountIdFromInfo(MOUNTINFO, '/var/witness')).toBe('32');
    expect(mountIdFromInfo(MOUNTINFO, '/srv/other')).toBe('22');
  });

  it('tells two mounts of one disk apart, which a device number would not', () => {
    expect(mountIdFromInfo(MOUNTINFO, '/var/state')).not.toBe(
      mountIdFromInfo(MOUNTINFO, '/var/witness')
    );
  });

  it('does not take a sibling whose name only starts the same', () => {
    expect(mountIdFromInfo(MOUNTINFO, '/var/statement')).toBe('22');
  });

  it('reads an escaped space in a mount point', () => {
    expect(mountIdFromInfo(MOUNTINFO, '/var/state/with space/x')).toBe('33');
  });

  it('answers nothing for text with no mount in it', () => {
    expect(mountIdFromInfo('', '/var/state')).toBeUndefined();
  });
});

describe('state witness', () => {
  let base: string;
  let stateDir: string;
  let witnessDir: string;
  let statePath: string;
  let clock: number;
  let allowances: Record<string, number | undefined>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'collector-witness-'));
    stateDir = join(base, 'state');
    witnessDir = join(base, 'witness');
    statePath = join(stateDir, 'usage.json');
    clock = Date.parse('2026-11-15T12:00:00.000Z');
    allowances = { 'tenant-a': 3 };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const mountKeyOf = (path: string): string => (path.startsWith(witnessDir) ? 'witness' : 'state');
  const witnessOf = (statePaths: string[] = [statePath]): StateWitness =>
    createStateWitness({ dir: witnessDir, statePaths, mountKeyOf });
  const markerOf = (): string => `${statePath}.initialised`;
  const witnessFiles = (): string[] => (existsSync(witnessDir) ? readdirSync(witnessDir) : []);

  function open(witness: StateWitness | null = witnessOf()): SweegoUsage {
    return createSweegoUsage({
      statePath,
      accountCap: 100,
      allowanceOf: (id) => allowances[id],
      now: () => clock,
      ...(witness ? { witness } : {}),
    });
  }

  /** The state volume replaced by a new empty one: file, marker and every sibling gone, the directory back. */
  function replaceStateVolume(): void {
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir);
  }

  describe('where the witness may live', () => {
    it('refuses to start with the witness on the same mount as a state file', () => {
      expect(() =>
        createStateWitness({
          dir: join(stateDir, 'witness'),
          statePaths: [statePath],
          mountKeyOf: () => 'one-mount',
        })
      ).toThrow(/COLLECTOR_STATE_WITNESS_DIR must be on a different mount/);
    });

    it('refuses with the real mount lookup when both directories are the same folder', () => {
      expect(() => createStateWitness({ dir: stateDir, statePaths: [statePath] })).toThrow(
        /different mount/
      );
    });

    it('accepts a witness on another mount', () => {
      expect(() => witnessOf()).not.toThrow();
    });
  });

  describe('the usage counter', () => {
    it('is a first run, counters at zero, on a genuinely new install', () => {
      const usage = open();
      expect(usage.accountState().total).toBe(0);
      expect(usage.accountCapReached()).toBe(false);
      expect(usage.allowanceReached('tenant-a')).toBe(false);
      expect(usage.reasons()).toEqual({});
      expect(witnessFiles()).toEqual([]);
    });

    it('writes the witness and then the marker on the first save, and carries on across restarts', () => {
      const usage = open();
      usage.begin('tenant-a')!.settle(true);
      expect(witnessFiles()).toHaveLength(1);
      expect(readFileSync(markerOf(), 'utf8')).toBe('initialised witnessed\n');
      const again = open();
      expect(again.accountState().total).toBe(1);
      expect(again.accountCapReached()).toBe(false);
      expect(again.begin('tenant-a')).toBeDefined();
      expect(again.reasons()).toEqual({});
    });

    it('holds when the state volume is replaced by an empty one, marker included', () => {
      open().begin('tenant-a')!.settle(true);
      replaceStateVolume();
      const usage = open();
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.begin('tenant-a')).toBeUndefined();
      expect(usage.accountState().vanished).toBe(true);
      expect(usage.reasons()).toEqual({ 'witness-mismatch': 1 });
    });

    it('keeps holding across a restart and a month change until the owner deletes the marker', () => {
      open().begin('tenant-a')!.settle(true);
      replaceStateVolume();
      open();
      expect(open().accountCapReached()).toBe(true);
      clock = Date.parse('2026-12-01T00:00:00.000Z');
      expect(open().accountCapReached()).toBe(true);
      expect(utcMonthOf(clock)).toBe('2026-12');
      rmSync(markerOf());
      const cleared = open();
      expect(cleared.accountCapReached()).toBe(false);
      expect(cleared.begin('tenant-a')).toBeDefined();
      expect(open().accountCapReached()).toBe(false);
    });

    it('holds when the witness is removed alone', () => {
      open().begin('tenant-a')!.settle(true);
      rmSync(witnessDir, { recursive: true });
      const usage = open();
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.begin('tenant-a')).toBeUndefined();
      expect(usage.reasons()).toEqual({ 'witness-mismatch': 1 });
      expect(open().accountCapReached()).toBe(true);
    });

    it('holds when the witness is no longer configured after it vouched for the file', () => {
      open().begin('tenant-a')!.settle(true);
      const usage = open(null);
      expect(usage.accountCapReached()).toBe(true);
      expect(usage.reasons()).toEqual({ 'witness-mismatch': 1 });
    });

    it('reads a file from before the witness as an upgrade, writes the witness, and then guards it', () => {
      mkdirSync(stateDir);
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: { 'tenant-a': { used: 2, latched: false } },
        })
      );
      writeFileSync(markerOf(), 'initialised\n');
      const usage = open();
      expect(usage.accountState().total).toBe(2);
      expect(usage.accountCapReached()).toBe(false);
      expect(usage.reasons()).toEqual({});
      expect(witnessFiles()).toHaveLength(1);
      expect(readFileSync(markerOf(), 'utf8')).toBe('initialised witnessed\n');
      rmSync(witnessDir, { recursive: true });
      expect(open().accountCapReached()).toBe(true);
    });

    it('runs unchanged with no witness configured', () => {
      const usage = open(null);
      usage.begin('tenant-a')!.settle(true);
      expect(readFileSync(markerOf(), 'utf8')).toBe('initialised\n');
      expect(open(null).accountState().total).toBe(1);
      replaceStateVolume();
      expect(open(null).accountCapReached()).toBe(false);
    });

    it('keeps the reservation in the file before the send, with the witness in place', () => {
      const usage = open();
      usage.begin('tenant-a', 'message-1');
      const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { inflight?: unknown[] };
      expect(saved.inflight).toHaveLength(1);
      expect(witnessFiles()).toHaveLength(1);
    });

    it('goes closed, as a failed write, when the witness cannot be written', () => {
      const usage = open();
      usage.begin('tenant-a')!.settle(true);
      const [file] = witnessFiles() as [string];
      rmSync(join(witnessDir, file));
      mkdirSync(join(witnessDir, file));
      replaceStateVolume();
      const blocked = open();
      expect(blocked.reasons()['state-write-failed']).toBeGreaterThanOrEqual(1);
      expect(blocked.begin('tenant-a')).toBeUndefined();
    });
  });

  describe('a latch written onto a replaced volume, with a write failing or the process dying part way', () => {
    // Each fault stops one of the three writes of the first save on the empty volume:
    // the witness, the marker, or the state file. The disk is then what a crash at
    // that point would leave; the next start must still read the volume as lost.
    const faults: Record<string, () => StateWitness> = {
      'the witness write fails': () => ({ ...witnessOf(), write: failWrite }),
      'the process dies after the witness is written, before the marker': () => {
        const real = witnessOf();
        return {
          probe: (path) => real.probe(path),
          write: (path) => {
            real.write(path);
            failWrite();
          },
        };
      },
      'the marker write fails': () => {
        mkdirSync(`${markerOf()}.tmp`, { recursive: true });
        return witnessOf();
      },
      'the state file write fails': () => {
        mkdirSync(`${statePath}.tmp`, { recursive: true });
        return witnessOf();
      },
    };

    function failWrite(): never {
      throw new Error('injected write failure');
    }

    function replaceAndOpenWith(fault: string): SweegoUsage {
      open().begin('tenant-a')!.settle(true);
      replaceStateVolume();
      return open(faults[fault]!());
    }

    function clearFaults(): void {
      rmSync(`${markerOf()}.tmp`, { recursive: true, force: true });
      rmSync(`${statePath}.tmp`, { recursive: true, force: true });
    }

    it.each(Object.keys(faults))('keeps the latch across a restart when %s', (fault) => {
      const first = replaceAndOpenWith(fault);
      expect(first.begin('tenant-a')).toBeUndefined();
      expect(first.reasons()['state-write-failed']).toBeGreaterThanOrEqual(1);
      clearFaults();
      const restarted = open();
      expect(restarted.accountCapReached()).toBe(true);
      expect(restarted.allowanceReached('tenant-a')).toBe(true);
      expect(restarted.begin('tenant-a')).toBeUndefined();
      expect(restarted.accountState().vanished).toBe(true);
    });

    it.each(Object.keys(faults))(
      'keeps the latch through a crash loop, then a good start, when %s',
      (fault) => {
        replaceAndOpenWith(fault);
        open(faults[fault]!());
        open(faults[fault]!());
        clearFaults();
        expect(open().accountCapReached()).toBe(true);
        expect(open().accountCapReached()).toBe(true);
        expect(readFileSync(markerOf(), 'utf8')).toBe('initialised witnessed\n');
      }
    );

    it('still lets the owner clear the latch by deleting the marker once it is fully written', () => {
      replaceAndOpenWith('the marker write fails');
      clearFaults();
      expect(open().accountCapReached()).toBe(true);
      rmSync(markerOf());
      expect(open().accountCapReached()).toBe(false);
    });
  });

  describe('the submitted-id and pin trackers', () => {
    const idsPath = (): string => join(stateDir, 'pins.json');
    const track = (witness: StateWitness | undefined, errors: string[] = []) =>
      createSubmittedTracker(60_000, () => clock, {
        statePath: idsPath(),
        ...(witness ? { witness } : {}),
        onError: (error) => errors.push(error.message),
      });

    it('is clean on a first run and with a consistent witness', () => {
      const witness = witnessOf([idsPath()]);
      const first = track(witness);
      expect(first.stateLost).toBe(false);
      first.markSubmitted('message-1');
      const again = track(witness);
      expect(again.stateLost).toBe(false);
      expect(again.has('message-1')).toBe(true);
    });

    it('is lost when the volume is replaced by an empty one', () => {
      const witness = witnessOf([idsPath()]);
      track(witness).markSubmitted('message-1');
      replaceStateVolume();
      const errors: string[] = [];
      const after = track(witness, errors);
      expect(after.stateLost).toBe(true);
      expect(after.has('message-1')).toBe(false);
      expect(errors).toEqual([expect.stringContaining('volume was replaced')]);
      expect(track(witness).stateLost).toBe(true);
    });

    it('is lost when the witness is removed alone, and says why', () => {
      const witness = witnessOf([idsPath()]);
      track(witness).markSubmitted('message-1');
      rmSync(witnessDir, { recursive: true });
      const errors: string[] = [];
      const after = track(witness, errors);
      expect(after.stateLost).toBe(true);
      expect(errors).toEqual([expect.stringContaining('witness')]);
    });

    it('reads a file from before the witness as an upgrade, not a loss', () => {
      track(undefined).markSubmitted('message-1');
      const witness = witnessOf([idsPath()]);
      const upgraded = track(witness);
      expect(upgraded.stateLost).toBe(false);
      expect(upgraded.has('message-1')).toBe(true);
      expect(witnessFiles()).toHaveLength(1);
      rmSync(witnessDir, { recursive: true });
      expect(track(witness).stateLost).toBe(true);
    });
  });
});

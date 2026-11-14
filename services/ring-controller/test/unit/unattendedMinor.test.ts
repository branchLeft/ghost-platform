import { describe, expect, it } from 'vitest';
import { RESTORE_DRILL_MAX_AGE_MS, UNATTENDED_MINOR_FLAG } from '../../src/minorEligibility.js';
import type { RestoreDrillRecord } from '../../src/minorEligibility.js';
import type { Release } from '../../src/ringController.js';
import { runUnattendedMinor } from '../../src/unattendedMinor.js';
import { CLEAN_ENV, DIGEST, bakeConfig, makeFleet, type Fleet } from './helpers/fakeFleet.js';

const FLAG_ON = Object.freeze({ [UNATTENDED_MINOR_FLAG]: 'on' });
const CURRENT = '6.55.0';
const MINOR: Release = { digest: DIGEST, version: '6.58.0', route: 'fast-path' };

/** A passing drill that finished a minute before the fleet's fake clock reads. */
const passingDrill = (fleet: Fleet): RestoreDrillRecord => ({
  result: 'pass',
  finishedAtMs: fleet.nowMs() - 60_000,
});

describe('runUnattendedMinor with the flag off (the default)', () => {
  it('declines a minor: no gates, no bump, no hold', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      { release: MINOR, currentVersion: CURRENT, restoreDrill: passingDrill(fleet) },
      fleet.deps,
      bakeConfig(),
      CLEAN_ENV
    );

    expect(outcome).toEqual({ status: 'declined', reason: 'flag-off' });
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.calls.newBump).toBe(0);
    expect(fleet.holds).toEqual([]);
  });

  it('declines when the flag holds any word but on', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      { release: MINOR, currentVersion: CURRENT, restoreDrill: passingDrill(fleet) },
      fleet.deps,
      bakeConfig(),
      { [UNATTENDED_MINOR_FLAG]: 'true' }
    );

    expect(outcome).toEqual({ status: 'declined', reason: 'flag-off' });
    expect(fleet.calls.newBump).toBe(0);
  });
});

describe('runUnattendedMinor with the flag on', () => {
  it('holds while no restore drill has passed: no gates, no bump, one hold', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      { release: MINOR, currentVersion: CURRENT, restoreDrill: undefined },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'preflight',
      reason: 'restore-drill-unmet',
      digest: DIGEST,
      version: '6.58.0',
    });
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.calls.newBump).toBe(0);
    expect(fleet.holds).toHaveLength(1);
    expect(fleet.pages).toEqual([]);
  });

  it('holds on a drill that passed too long ago', async () => {
    const fleet = makeFleet();
    const stale: RestoreDrillRecord = {
      result: 'pass',
      finishedAtMs: fleet.nowMs() - RESTORE_DRILL_MAX_AGE_MS - 1,
    };
    const outcome = await runUnattendedMinor(
      { release: MINOR, currentVersion: CURRENT, restoreDrill: stale },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toMatchObject({ status: 'held', reason: 'restore-drill-unmet' });
    expect(fleet.calls.newBump).toBe(0);
  });

  it('takes an eligible minor through every ring once the drill has passed', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      { release: MINOR, currentVersion: CURRENT, restoreDrill: passingDrill(fleet) },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toEqual({ status: 'completed' });
    expect(fleet.calls.runGates).toBe(1);
    expect(fleet.ringsInBumpOrder()).toEqual(['slot-0', 'demos', 'entry', 'professional']);
    expect(fleet.holds).toEqual([]);
  });

  it('takes an eligible patch through every ring too', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      {
        release: { ...MINOR, version: '6.55.2' },
        currentVersion: CURRENT,
        restoreDrill: passingDrill(fleet),
      },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toEqual({ status: 'completed' });
  });

  it('holds a major as consent-required, with no gate run, even if its route says fast-path', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      {
        release: { ...MINOR, version: '7.0.0' },
        currentVersion: CURRENT,
        restoreDrill: passingDrill(fleet),
      },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toMatchObject({ status: 'held', at: 'preflight', reason: 'consent-required' });
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.calls.newBump).toBe(0);
  });

  it('holds a consent-route minor as consent-required', async () => {
    const fleet = makeFleet();
    const outcome = await runUnattendedMinor(
      {
        release: { ...MINOR, route: 'consent' },
        currentVersion: CURRENT,
        restoreDrill: passingDrill(fleet),
      },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toMatchObject({ status: 'held', reason: 'consent-required' });
    expect(fleet.calls.runGates).toBe(0);
  });

  it('holds a version it cannot read or an older one as version-not-eligible', async () => {
    for (const version of ['6.58.0-rc.1', '6.54.0']) {
      const fleet = makeFleet();
      const outcome = await runUnattendedMinor(
        {
          release: { ...MINOR, version },
          currentVersion: CURRENT,
          restoreDrill: passingDrill(fleet),
        },
        fleet.deps,
        bakeConfig(),
        FLAG_ON
      );

      expect(outcome).toMatchObject({ status: 'held', reason: 'version-not-eligible' });
      expect(fleet.calls.newBump).toBe(0);
    }
  });

  it('still holds on a red gate after it is found eligible', async () => {
    const fleet = makeFleet({
      gates: (digest) => ({ digest, results: [{ name: 'migrations', ok: false }] }),
    });
    const outcome = await runUnattendedMinor(
      { release: MINOR, currentVersion: CURRENT, restoreDrill: passingDrill(fleet) },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );

    expect(outcome).toMatchObject({ status: 'held', at: 'gates', reason: 'gate-red' });
    expect(fleet.calls.newBump).toBe(0);
  });

  it('refuses to run with a model key present, flag on or off', async () => {
    for (const env of [{ ...FLAG_ON, ANTHROPIC_API_KEY: 'x' }, { OPENAI_API_KEY: 'x' }]) {
      const fleet = makeFleet();
      await expect(
        runUnattendedMinor(
          { release: MINOR, currentVersion: CURRENT, restoreDrill: passingDrill(fleet) },
          fleet.deps,
          bakeConfig(),
          env
        )
      ).rejects.toMatchObject({ name: 'ModelKeyPresentError' });
      expect(fleet.calls.runGates).toBe(0);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoCeilings } from '../../src/demoCeilings.js';

const HOUR = 60 * 60 * 1000;

describe('the demo ceilings: per slot, and per estate', () => {
  let now: number;
  let dir: string;

  beforeEach(() => {
    now = 1_000_000;
    dir = mkdtempSync(join(tmpdir(), 'demo-ceilings-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (
    options: Partial<Parameters<typeof createDemoCeilings>[0]> = {}
  ): ReturnType<typeof createDemoCeilings> =>
    createDemoCeilings({
      estateCeiling: 100,
      defaultSlotCeiling: 3,
      windowMs: 24 * HOUR,
      now: () => now,
      ...options,
    });

  it("refuses a slot's message past its own ceiling and takes nothing for the refusal", () => {
    const ceilings = make();
    expect(['a', 'b', 'c'].map((id) => ceilings.reserve('slot-a', id))).toEqual(['ok', 'ok', 'ok']);
    expect(ceilings.reserve('slot-a', 'd')).toBe('slot');
    expect(ceilings.size).toBe(3);
  });

  it("does not let one slot's exhaustion stop another slot", () => {
    const ceilings = make();
    for (const id of ['a', 'b', 'c']) {
      ceilings.reserve('slot-a', id);
    }
    expect(ceilings.reserve('slot-a', 'd')).toBe('slot');
    expect(ceilings.reserve('slot-b', 'a')).toBe('ok');
  });

  it('stops every slot once the estate ceiling is reached, one that has used none included', () => {
    const ceilings = make({ estateCeiling: 4 });
    expect(ceilings.reserve('slot-a', '1')).toBe('ok');
    expect(ceilings.reserve('slot-a', '2')).toBe('ok');
    expect(ceilings.reserve('slot-b', '1')).toBe('ok');
    expect(ceilings.reserve('slot-b', '2')).toBe('ok');
    expect(ceilings.reserve('slot-c', '1')).toBe('estate');
    expect(ceilings.reserve('slot-a', '3')).toBe('estate');
  });

  it("uses the slot's own ceiling when the descriptor names one, including zero", () => {
    const ceilings = make();
    expect(ceilings.reserve('slot-a', '1', 1)).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', 1)).toBe('slot');
    expect(ceilings.reserve('slot-z', '1', 0)).toBe('slot');
  });

  it('falls back to the default for a ceiling that is not a whole number', () => {
    const ceilings = make({ defaultSlotCeiling: 1 });
    expect(ceilings.reserve('slot-a', '1', -1)).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', Number.NaN)).toBe('slot');
  });

  it('gives a re-offered message the place it already holds, never a second', () => {
    const ceilings = make({ defaultSlotCeiling: 1 });
    expect(ceilings.reserve('slot-a', 'm1')).toBe('ok');
    expect(ceilings.reserve('slot-a', 'm1')).toBe('ok');
    expect(ceilings.size).toBe(1);
    expect(ceilings.reserve('slot-a', 'm2')).toBe('slot');
  });

  it('keys a place on the slot and the id together, so two slots may share an id', () => {
    const ceilings = make({ defaultSlotCeiling: 1 });
    expect(ceilings.reserve('slot-a', '1')).toBe('ok');
    expect(ceilings.reserve('slot-b', '1')).toBe('ok');
    expect(ceilings.size).toBe(2);
  });

  it('frees a place once the window has passed', () => {
    const ceilings = make({ defaultSlotCeiling: 1, windowMs: HOUR });
    expect(ceilings.reserve('slot-a', '1')).toBe('ok');
    expect(ceilings.reserve('slot-a', '2')).toBe('slot');
    now += HOUR;
    expect(ceilings.reserve('slot-a', '2')).toBe('ok');
  });

  it('reports the slot ceiling before the estate one when both are full', () => {
    const ceilings = make({ defaultSlotCeiling: 1, estateCeiling: 1 });
    expect(ceilings.reserve('slot-a', '1')).toBe('ok');
    expect(ceilings.reserve('slot-a', '2')).toBe('slot');
    expect(ceilings.reserve('slot-b', '1')).toBe('estate');
  });

  describe('across a restart', () => {
    it('keeps the places, so a restart is not a fresh ceiling', () => {
      const statePath = join(dir, 'state', 'demo-ceilings.json');
      const first = make({ statePath, defaultSlotCeiling: 2, estateCeiling: 3 });
      first.reserve('slot-a', '1');
      first.reserve('slot-a', '2');
      first.reserve('slot-b', '1');
      const second = make({ statePath, defaultSlotCeiling: 2, estateCeiling: 3 });
      expect(second.size).toBe(3);
      expect(second.reserve('slot-a', '3')).toBe('slot');
      expect(second.reserve('slot-c', '1')).toBe('estate');
      expect(second.reserve('slot-a', '1')).toBe('ok');
    });

    it('starts empty and reports, never throws, for a state file it cannot read', () => {
      const statePath = join(dir, 'demo-ceilings.json');
      writeFileSync(statePath, '{ not json');
      const errors: Error[] = [];
      const ceilings = make({ statePath, onError: (error) => errors.push(error) });
      expect(ceilings.size).toBe(0);
      expect(errors).toHaveLength(1);
      expect(ceilings.reserve('slot-a', '1')).toBe('ok');
    });

    it('reports a state file it cannot write and carries on counting in memory', () => {
      const errors: Error[] = [];
      // A directory where the file should be: the rename fails.
      const ceilings = make({
        statePath: dir,
        defaultSlotCeiling: 1,
        onError: (error) => errors.push(error),
      });
      expect(ceilings.reserve('slot-a', '1')).toBe('ok');
      expect(errors.length).toBeGreaterThan(0);
      expect(ceilings.reserve('slot-a', '2')).toBe('slot');
    });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoCeilings } from '../../src/demoCeilings.js';
import type { MailClass } from '../../src/sendingTarget.js';

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

  const both = (ceiling: number): Record<MailClass, number> => ({
    transactional: ceiling,
    bulk: ceiling,
  });

  type MakeOptions = Omit<
    Partial<Parameters<typeof createDemoCeilings>[0]>,
    'estateCeiling' | 'defaultSlotCeiling'
  > & {
    estateCeiling?: number | Record<MailClass, number>;
    defaultSlotCeiling?: number | Record<MailClass, number>;
  };

  const asClasses = (ceiling: number | Record<MailClass, number>): Record<MailClass, number> =>
    typeof ceiling === 'number' ? both(ceiling) : ceiling;

  const make = (options: MakeOptions = {}): ReturnType<typeof createDemoCeilings> =>
    createDemoCeilings({
      windowMs: 24 * HOUR,
      now: () => now,
      ...options,
      estateCeiling: asClasses(options.estateCeiling ?? 100),
      defaultSlotCeiling: asClasses(options.defaultSlotCeiling ?? 3),
    });

  it("refuses a slot's message past its own ceiling and takes nothing for the refusal", () => {
    const ceilings = make();
    expect(['a', 'b', 'c'].map((id) => ceilings.reserve('slot-a', id, 'bulk'))).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
    expect(ceilings.reserve('slot-a', 'd', 'bulk')).toBe('slot');
    expect(ceilings.size).toBe(3);
  });

  it("does not let one slot's exhaustion stop another slot", () => {
    const ceilings = make();
    for (const id of ['a', 'b', 'c']) {
      ceilings.reserve('slot-a', id, 'bulk');
    }
    expect(ceilings.reserve('slot-a', 'd', 'bulk')).toBe('slot');
    expect(ceilings.reserve('slot-b', 'a', 'bulk')).toBe('ok');
  });

  it('stops every slot once the estate ceiling is reached, one that has used none included', () => {
    const ceilings = make({ estateCeiling: 4 });
    expect(ceilings.reserve('slot-a', '1', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-b', '1', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-b', '2', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-c', '1', 'bulk')).toBe('estate');
    expect(ceilings.reserve('slot-a', '3', 'bulk')).toBe('estate');
  });

  it("uses the slot's own ceiling when the descriptor names one, including zero", () => {
    const ceilings = make();
    expect(ceilings.reserve('slot-a', '1', 'bulk', 1)).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', 'bulk', 1)).toBe('slot');
    expect(ceilings.reserve('slot-z', '1', 'bulk', 0)).toBe('slot');
  });

  it('falls back to the default for a ceiling that is not a whole number', () => {
    const ceilings = make({ defaultSlotCeiling: 1 });
    expect(ceilings.reserve('slot-a', '1', 'bulk', -1)).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', 'bulk', Number.NaN)).toBe('slot');
  });

  it('gives a re-offered message the place it already holds, never a second', () => {
    const ceilings = make({ defaultSlotCeiling: 1 });
    expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
    expect(ceilings.size).toBe(1);
    expect(ceilings.reserve('slot-a', 'm2', 'bulk')).toBe('slot');
  });

  it('keys a place on the slot and the id together, so two slots may share an id', () => {
    const ceilings = make({ defaultSlotCeiling: 1 });
    expect(ceilings.reserve('slot-a', '1', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-b', '1', 'bulk')).toBe('ok');
    expect(ceilings.size).toBe(2);
  });

  it('frees a place once the window has passed', () => {
    const ceilings = make({ defaultSlotCeiling: 1, windowMs: HOUR });
    expect(ceilings.reserve('slot-a', '1', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', 'bulk')).toBe('slot');
    now += HOUR;
    expect(ceilings.reserve('slot-a', '2', 'bulk')).toBe('ok');
  });

  it('reports the slot ceiling before the estate one when both are full', () => {
    const ceilings = make({ defaultSlotCeiling: 1, estateCeiling: 1 });
    expect(ceilings.reserve('slot-a', '1', 'bulk')).toBe('ok');
    expect(ceilings.reserve('slot-a', '2', 'bulk')).toBe('slot');
    expect(ceilings.reserve('slot-b', '1', 'bulk')).toBe('estate');
  });

  describe('per mail class: sign-in and newsletters are counted apart', () => {
    it('newsletter_ceiling_does_not_spend_sign_in_place', () => {
      // The same ids in both classes: a counter keyed without the class would
      // treat the sign-in message as a re-offer of the newsletter.
      const ceilings = make({ defaultSlotCeiling: 2 });
      expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm2', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm3', 'bulk')).toBe('slot');
      expect(ceilings.reserve('slot-a', 'm1', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm2', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm3', 'transactional')).toBe('slot');
      expect(ceilings.size).toBe(4);
    });

    it('sign_in_ceiling_does_not_spend_newsletter_place', () => {
      const ceilings = make({ defaultSlotCeiling: 2 });
      expect(ceilings.reserve('slot-a', 'm1', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm2', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm3', 'transactional')).toBe('slot');
      expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm2', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm3', 'bulk')).toBe('slot');
      expect(ceilings.size).toBe(4);
    });

    it('estate_newsletter_and_sign_in_counted_separately', () => {
      const ceilings = make({ estateCeiling: 2 });
      expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-b', 'm1', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-c', 'm1', 'bulk')).toBe('estate');
      expect(ceilings.reserve('slot-a', 'm1', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-b', 'm1', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-c', 'm1', 'transactional')).toBe('estate');
      expect(ceilings.size).toBe(4);
    });

    it('takes each class its own ceilings, so the two classes need not match', () => {
      const ceilings = make({
        defaultSlotCeiling: { transactional: 1, bulk: 3 },
        estateCeiling: { transactional: 10, bulk: 4 },
      });
      expect(ceilings.reserve('slot-a', 's1', 'transactional')).toBe('ok');
      expect(ceilings.reserve('slot-a', 's2', 'transactional')).toBe('slot');
      expect(['n1', 'n2', 'n3'].map((id) => ceilings.reserve('slot-a', id, 'bulk'))).toEqual([
        'ok',
        'ok',
        'ok',
      ]);
      expect(ceilings.reserve('slot-a', 'n4', 'bulk')).toBe('slot');
      expect(ceilings.reserve('slot-b', 'n1', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-c', 'n1', 'bulk')).toBe('estate');
    });

    it("refuses a class at its slot ceiling with 'slot' and at its estate ceiling with 'estate'", () => {
      const slotFull = make({ defaultSlotCeiling: 1 });
      expect(slotFull.reserve('slot-a', 's1', 'transactional')).toBe('ok');
      expect(slotFull.reserve('slot-a', 's2', 'transactional')).toBe('slot');
      const estateFull = make({ estateCeiling: 1 });
      expect(estateFull.reserve('slot-a', 'n1', 'bulk')).toBe('ok');
      expect(estateFull.reserve('slot-b', 'n2', 'bulk')).toBe('estate');
    });

    it('applies a descriptor ceiling to each class on its own', () => {
      const ceilings = make();
      expect(ceilings.reserve('slot-a', 'n1', 'bulk', 1)).toBe('ok');
      expect(ceilings.reserve('slot-a', 'n2', 'bulk', 1)).toBe('slot');
      expect(ceilings.reserve('slot-a', 's1', 'transactional', 1)).toBe('ok');
      expect(ceilings.reserve('slot-a', 's2', 'transactional', 1)).toBe('slot');
    });

    it('gives a re-offered message its place again, free, in its own class only', () => {
      const ceilings = make({ defaultSlotCeiling: 1 });
      expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
      expect(ceilings.reserve('slot-a', 'm1', 'bulk')).toBe('ok');
      expect(ceilings.size).toBe(1);
      expect(ceilings.reserve('slot-a', 'm1', 'transactional')).toBe('ok');
      expect(ceilings.size).toBe(2);
    });
  });

  describe('across a restart', () => {
    it('keeps the places, so a restart is not a fresh ceiling', () => {
      const statePath = join(dir, 'state', 'demo-ceilings.json');
      const first = make({ statePath, defaultSlotCeiling: 2, estateCeiling: 3 });
      first.reserve('slot-a', '1', 'bulk');
      first.reserve('slot-a', '2', 'bulk');
      first.reserve('slot-b', '1', 'bulk');
      const second = make({ statePath, defaultSlotCeiling: 2, estateCeiling: 3 });
      expect(second.size).toBe(3);
      expect(second.reserve('slot-a', '3', 'bulk')).toBe('slot');
      expect(second.reserve('slot-c', '1', 'bulk')).toBe('estate');
      expect(second.reserve('slot-a', '1', 'bulk')).toBe('ok');
    });

    it('keeps each class counted apart across a restart', () => {
      const statePath = join(dir, 'demo-ceilings.json');
      const first = make({ statePath, defaultSlotCeiling: 1 });
      first.reserve('slot-a', 'n1', 'bulk');
      const second = make({ statePath, defaultSlotCeiling: 1 });
      expect(second.reserve('slot-a', 'n2', 'bulk')).toBe('slot');
      expect(second.reserve('slot-a', 's1', 'transactional')).toBe('ok');
    });

    describe('a state file written before places had a mail class', () => {
      const legacyState = (rows: object[]): string => JSON.stringify({ version: 1, places: rows });

      it('counts each old place against both classes, so no ceiling is lifted', () => {
        const statePath = join(dir, 'demo-ceilings.json');
        writeFileSync(
          statePath,
          legacyState([{ key: 'slot-a\u0000old-1', slot: 'slot-a', at: now - HOUR }])
        );
        const errors: Error[] = [];
        const ceilings = make({
          statePath,
          defaultSlotCeiling: 1,
          onError: (error) => errors.push(error),
        });
        expect(errors).toEqual([]);
        expect(ceilings.size).toBe(2);
        expect(ceilings.reserve('slot-a', 'n1', 'bulk')).toBe('slot');
        expect(ceilings.reserve('slot-a', 's1', 'transactional')).toBe('slot');
        expect(ceilings.reserve('slot-b', 'n1', 'bulk')).toBe('ok');
      });

      it('lets the same old message be re-offered in either class for free', () => {
        const statePath = join(dir, 'demo-ceilings.json');
        writeFileSync(
          statePath,
          legacyState([{ key: 'slot-a\u0000old-1', slot: 'slot-a', at: now - HOUR }])
        );
        const ceilings = make({ statePath, defaultSlotCeiling: 1 });
        expect(ceilings.reserve('slot-a', 'old-1', 'bulk')).toBe('ok');
        expect(ceilings.reserve('slot-a', 'old-1', 'transactional')).toBe('ok');
        expect(ceilings.size).toBe(2);
      });

      it('expires an old place with the window, like any other', () => {
        const statePath = join(dir, 'demo-ceilings.json');
        writeFileSync(
          statePath,
          legacyState([{ key: 'slot-a\u0000old-1', slot: 'slot-a', at: now }])
        );
        const ceilings = make({ statePath, defaultSlotCeiling: 1, windowMs: HOUR });
        now += HOUR;
        expect(ceilings.reserve('slot-a', 'n1', 'bulk')).toBe('ok');
        expect(ceilings.size).toBe(1);
      });

      it('counts a place that names an unknown class against both, never against neither', () => {
        const statePath = join(dir, 'demo-ceilings.json');
        writeFileSync(
          statePath,
          legacyState([{ key: 'slot-a\u0000x', slot: 'slot-a', mailClass: 'surprise', at: now }])
        );
        const ceilings = make({ statePath, defaultSlotCeiling: 1 });
        expect(ceilings.reserve('slot-a', 'n1', 'bulk')).toBe('slot');
        expect(ceilings.reserve('slot-a', 's1', 'transactional')).toBe('slot');
      });

      it('writes the old places back with a class each, and a second restart agrees', () => {
        const statePath = join(dir, 'demo-ceilings.json');
        writeFileSync(
          statePath,
          legacyState([{ key: 'slot-a\u0000old-1', slot: 'slot-a', at: now }])
        );
        const first = make({ statePath, defaultSlotCeiling: 2 });
        first.reserve('slot-b', 'n1', 'bulk');
        const second = make({ statePath, defaultSlotCeiling: 1 });
        expect(second.size).toBe(3);
        expect(second.reserve('slot-a', 'n2', 'bulk')).toBe('slot');
        expect(second.reserve('slot-a', 's2', 'transactional')).toBe('slot');
      });
    });

    it('starts empty and reports, never throws, for a state file it cannot read', () => {
      const statePath = join(dir, 'demo-ceilings.json');
      writeFileSync(statePath, '{ not json');
      const errors: Error[] = [];
      const ceilings = make({ statePath, onError: (error) => errors.push(error) });
      expect(ceilings.size).toBe(0);
      expect(errors).toHaveLength(1);
      expect(ceilings.reserve('slot-a', '1', 'bulk')).toBe('ok');
    });

    it('reports a state file it cannot write and carries on counting in memory', () => {
      const errors: Error[] = [];
      // A directory where the file should be: the rename fails.
      const ceilings = make({
        statePath: dir,
        defaultSlotCeiling: 1,
        onError: (error) => errors.push(error),
      });
      expect(ceilings.reserve('slot-a', '1', 'bulk')).toBe('ok');
      expect(errors.length).toBeGreaterThan(0);
      expect(ceilings.reserve('slot-a', '2', 'bulk')).toBe('slot');
    });
  });
});

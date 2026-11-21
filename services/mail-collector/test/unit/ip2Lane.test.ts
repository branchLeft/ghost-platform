import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_SHARE_PERCENT,
  IP2_STAGES,
  createIp2Lane,
  destinationGroupOf,
  ip2State,
  isDefiniteNonAcceptance,
  parseIp2Paths,
  parseIp2State,
  type Ip2Lane,
} from '../../src/ip2Lane.js';

/**
 * The newsletter lane's caps and hold, with an injected clock and real files.
 * The stage table is pinned to the accepted design's numbers: a changed cap
 * must change this test on purpose.
 */

const DAY1 = Date.parse('2026-11-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('the stage table', () => {
  it('is the accepted design, stage by stage: total, then Gmail / Microsoft / Yahoo', () => {
    expect(IP2_STAGES.map((s) => [s.stage, s.total, s.gmail, s.microsoft, s.yahoo])).toEqual([
      [1, 50, 25, 15, 15],
      [2, 100, 50, 30, 30],
      [3, 200, 100, 60, 60],
      [4, 400, 200, 120, 120],
      [5, 800, 400, 240, 240],
      [6, 1600, 800, 480, 480],
      [7, 3200, 1600, 960, 960],
    ]);
  });

  it('keeps the demo share at 20 percent', () => {
    expect(DEMO_SHARE_PERCENT).toBe(20);
  });
});

describe('destinationGroupOf', () => {
  it.each([
    ['a@gmail.com', 'gmail'],
    ['a@GoogleMail.com', 'gmail'],
    ['a@outlook.com', 'microsoft'],
    ['a@hotmail.co.uk', 'microsoft'],
    ['a@live.com', 'microsoft'],
    ['a@yahoo.com', 'yahoo'],
    ['a@ymail.com', 'yahoo'],
    ['a@example.com', undefined],
    ['a@mail.gmail.com', undefined],
    ['a@notgmail.com', undefined],
    ['gmail.com@example.com', undefined],
  ])('%s is %s', (address, group) => {
    expect(destinationGroupOf(address)).toBe(group);
  });
});

describe('parseIp2State', () => {
  it('reads a valid file', () => {
    expect(parseIp2State({ stage: 3, held: false, destinationHolds: ['yahoo'] })).toEqual({
      stage: 3,
      held: false,
      destinationHolds: ['yahoo'],
    });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['no stage', { held: false, destinationHolds: [] }],
    ['stage 0', { stage: 0, held: false, destinationHolds: [] }],
    ['stage 8', { stage: 8, held: false, destinationHolds: [] }],
    ['a fractional stage', { stage: 1.5, held: false, destinationHolds: [] }],
    ['a string stage', { stage: '1', held: false, destinationHolds: [] }],
    ['held as a string', { stage: 1, held: 'no', destinationHolds: [] }],
    ['no held', { stage: 1, destinationHolds: [] }],
    ['no destinationHolds', { stage: 1, held: false }],
    ['an unknown group', { stage: 1, held: false, destinationHolds: ['aol'] }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseIp2State(raw)).toThrow();
  });
});

describe('parseIp2Paths', () => {
  it('is off with neither set', () => {
    expect(parseIp2Paths(undefined, undefined)).toBeUndefined();
    expect(parseIp2Paths('', '')).toBeUndefined();
  });

  it('refuses a state path without a counter path, and the reverse', () => {
    expect(() => parseIp2Paths('/s.json', undefined)).toThrow(/COLLECTOR_IP2_COUNTER_PATH/);
    expect(() => parseIp2Paths(undefined, '/c.json')).toThrow(/COLLECTOR_IP2_STATE_PATH/);
  });

  it('refuses one file for both', () => {
    expect(() => parseIp2Paths('/a.json', '/a.json')).toThrow(/different files/);
  });

  it('reads both', () => {
    expect(parseIp2Paths('/s.json', '/c.json')).toEqual({
      statePath: '/s.json',
      counterPath: '/c.json',
    });
  });
});

describe('isDefiniteNonAcceptance', () => {
  it.each(['CONN', 'EHLO', 'AUTH PLAIN', 'MAIL FROM', 'RCPT TO'])('%s is definite', (command) => {
    expect(isDefiniteNonAcceptance({ command })).toBe(true);
  });

  it.each([{ command: 'DATA' }, { command: 'API' }, {}, new Error('timeout'), null, 'x'])(
    'may have been taken: %j',
    (error) => {
      expect(isDefiniteNonAcceptance(error)).toBe(false);
    }
  );
});

describe('the lane', () => {
  let dir: string;
  let statePath: string;
  let counterPath: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ip2-'));
    statePath = join(dir, 'state.json');
    counterPath = join(dir, 'counter.json');
    clock = DAY1;
    writeState({ stage: 1, held: false, destinationHolds: [] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeState(state: unknown): void {
    writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state));
  }

  function lane(): Ip2Lane {
    return createIp2Lane({ statePath, counterPath, now: () => clock });
  }

  let seq = 0;
  function send(l: Ip2Lane, to: string, demo = false): boolean {
    seq += 1;
    return l.reserve({ id: `m-${seq}`, to, demo }).ok;
  }

  function reasonOf(l: Ip2Lane, to: string, demo = false): string | undefined {
    seq += 1;
    const decision = l.reserve({ id: `m-${seq}`, to, demo });
    return decision.ok ? undefined : decision.reason;
  }

  it('holds the 51st newsletter message of a stage-1 day and sends it the next UTC day', () => {
    const l = lane();
    for (let i = 0; i < 50; i += 1) {
      expect(send(l, `r${i}@example.com`)).toBe(true);
    }
    const waiting = { id: 'waiting', to: 'late@example.com', demo: false };
    const refused = l.reserve(waiting);
    expect(refused).toEqual({ ok: false, reason: 'total_cap' });
    clock += DAY_MS;
    expect(l.reserve(waiting).ok).toBe(true);
  });

  it('holds the 26th Gmail message of a stage-1 day while the 26th other-domain message goes', () => {
    const l = lane();
    for (let i = 0; i < 25; i += 1) {
      expect(send(l, `g${i}@gmail.com`)).toBe(true);
    }
    expect(reasonOf(l, 'g25@gmail.com')).toBe('destination_cap');
    expect(send(l, 'other@example.com')).toBe(true);
    expect(reasonOf(l, 'g26@googlemail.com')).toBe('destination_cap');
  });

  it.each([
    ['microsoft', 'a@outlook.com', 15],
    ['yahoo', 'a@yahoo.com', 15],
  ])('caps %s at %i on stage 1', (_group, address, cap) => {
    const l = lane();
    for (let i = 0; i < cap; i += 1) {
      expect(send(l, address)).toBe(true);
    }
    expect(reasonOf(l, address)).toBe('destination_cap');
    expect(send(l, 'other@example.com')).toBe(true);
  });

  describe.each(IP2_STAGES)('stage $stage, at its table values', (caps) => {
    // From stage 3 on demo mail has no share limit; before it, the share is not under test here.
    const demo = caps.stage >= 3;

    // The day's count is seeded one place short of a cap, in the file a
    // restart would read: every stage is checked without sending thousands.
    function seeded(counts: {
      total: number;
      gmail: number;
      microsoft: number;
      yahoo: number;
    }): Ip2Lane {
      writeState({ stage: caps.stage, held: false, destinationHolds: [] });
      writeFileSync(
        counterPath,
        JSON.stringify({
          version: 1,
          day: '2026-11-19',
          total: counts.total,
          demo: 0,
          destinations: {
            gmail: counts.gmail,
            microsoft: counts.microsoft,
            yahoo: counts.yahoo,
          },
          ids: [],
        })
      );
      return lane();
    }

    it.each([
      ['gmail', 'a@gmail.com'],
      ['microsoft', 'a@outlook.com'],
      ['yahoo', 'a@yahoo.com'],
    ] as const)('takes the last %s place and holds the next', (group, address) => {
      const l = seeded({ total: 0, gmail: 0, microsoft: 0, yahoo: 0, [group]: caps[group] - 1 });
      expect(send(l, address, demo)).toBe(true);
      expect(reasonOf(l, address, demo)).toBe('destination_cap');
      expect(send(l, 'o@example.com', demo)).toBe(true);
    });

    it('takes the last place of the day and holds the next, whoever it is for', () => {
      const l = seeded({ total: caps.total - 1, gmail: 0, microsoft: 0, yahoo: 0 });
      expect(send(l, 'o@example.com', demo)).toBe(true);
      expect(reasonOf(l, 'o@example.com', demo)).toBe('total_cap');
      expect(reasonOf(l, 'a@gmail.com', demo)).toBe('total_cap');
    });
  });

  it('keeps the count across a restart in the same day', () => {
    const first = lane();
    for (let i = 0; i < 50; i += 1) {
      send(first, `r${i}@example.com`);
    }
    const restarted = lane();
    expect(reasonOf(restarted, 'late@example.com')).toBe('total_cap');
    expect(ip2State(restarted).sentToday).toBe(50);
  });

  it('rolls the day at midnight UTC and not before', () => {
    clock = Date.parse('2026-11-19T23:59:59.999Z');
    const l = lane();
    for (let i = 0; i < 50; i += 1) {
      send(l, `r${i}@example.com`);
    }
    expect(reasonOf(l, 'a@example.com')).toBe('total_cap');
    clock = Date.parse('2026-11-20T00:00:00.000Z');
    expect(send(l, 'b@example.com')).toBe(true);
    expect(ip2State(l).sentToday).toBe(1);
  });

  it('does not reset the day when the clock is set back', () => {
    const l = lane();
    for (let i = 0; i < 50; i += 1) {
      send(l, `r${i}@example.com`);
    }
    clock -= 2 * DAY_MS;
    expect(reasonOf(l, 'a@example.com')).toBe('total_cap');
  });

  it('writes the count down before it returns', () => {
    const l = lane();
    send(l, 'a@gmail.com');
    const written = JSON.parse(readFileSync(counterPath, 'utf8')) as {
      day: string;
      total: number;
      destinations: { gmail: number };
    };
    expect(written).toMatchObject({ day: '2026-11-19', total: 1, destinations: { gmail: 1 } });
  });

  it('refuses when the count cannot be written, and counts nothing for it', () => {
    const l = lane();
    send(l, 'a@example.com');
    // A directory where the temp file goes makes every write fail.
    mkdirSync(`${counterPath}.tmp`);
    expect(reasonOf(l, 'b@example.com')).toBe('counter_write_failed');
    rmSync(`${counterPath}.tmp`, { recursive: true });
    expect(ip2State(l).sentToday).toBe(1);
    expect(send(l, 'b@example.com')).toBe(true);
    expect(ip2State(l).sentToday).toBe(2);
  });

  describe('the operator hold', () => {
    it('stops every message while held, and releases it when the file says so', () => {
      const l = lane();
      writeState({ stage: 1, held: true, destinationHolds: [] });
      expect(reasonOf(l, 'a@example.com')).toBe('held');
      expect(reasonOf(l, 'a@gmail.com')).toBe('held');
      expect(ip2State(l).held).toBe(true);
      writeState({ stage: 1, held: false, destinationHolds: [] });
      expect(send(l, 'a@example.com')).toBe(true);
      expect(ip2State(l).held).toBe(false);
    });

    it('stops one destination group and no other', () => {
      const l = lane();
      writeState({ stage: 1, held: false, destinationHolds: ['microsoft'] });
      expect(reasonOf(l, 'a@outlook.com')).toBe('destination_held');
      expect(reasonOf(l, 'a@hotmail.com')).toBe('destination_held');
      expect(send(l, 'a@gmail.com')).toBe(true);
      expect(send(l, 'a@yahoo.com')).toBe(true);
      expect(send(l, 'a@example.com')).toBe(true);
    });

    it('takes a stage change on the next message', () => {
      const l = lane();
      for (let i = 0; i < 50; i += 1) {
        send(l, `r${i}@example.com`);
      }
      expect(reasonOf(l, 'a@example.com')).toBe('total_cap');
      writeState({ stage: 2, held: false, destinationHolds: [] });
      expect(send(l, 'a@example.com')).toBe(true);
      expect(ip2State(l)).toEqual({ stage: 2, sentToday: 51, cap: 100, held: false });
    });
  });

  describe('a state file that cannot be trusted holds the lane', () => {
    it.each([
      ['missing', undefined],
      ['not JSON', '{ nope'],
      ['empty', ''],
      ['an unknown stage', JSON.stringify({ stage: 9, held: false, destinationHolds: [] })],
      ['an unknown group', JSON.stringify({ stage: 1, held: false, destinationHolds: ['aol'] })],
    ])('%s', (_name, content) => {
      const l = lane();
      if (content === undefined) {
        rmSync(statePath);
      } else {
        writeState(content);
      }
      expect(reasonOf(l, 'a@example.com')).toBe('state_unreadable');
      expect(ip2State(l)).toMatchObject({ stage: undefined, cap: undefined, held: true });
      writeState({ stage: 1, held: false, destinationHolds: [] });
      expect(send(l, 'a@example.com')).toBe(true);
    });
  });

  describe('a counter file that cannot be trusted holds the lane', () => {
    it.each([
      ['not JSON', '{ nope'],
      ['a wrong shape', '{"version":1,"day":"x"}'],
      [
        'a negative count',
        JSON.stringify({
          version: 1,
          day: '2026-11-19',
          total: -1,
          demo: 0,
          destinations: { gmail: 0, microsoft: 0, yahoo: 0 },
          ids: [],
        }),
      ],
    ])('%s, never reset on a guess', (_name, content) => {
      writeFileSync(counterPath, content);
      const l = lane();
      expect(reasonOf(l, 'a@example.com')).toBe('counter_unreadable');
      expect(ip2State(l).held).toBe(true);
      // Repaired by the operator: picked up without a restart.
      writeFileSync(
        counterPath,
        JSON.stringify({
          version: 1,
          day: '2026-11-19',
          total: 50,
          demo: 0,
          destinations: { gmail: 0, microsoft: 0, yahoo: 0 },
          ids: [],
        })
      );
      expect(reasonOf(l, 'a@example.com')).toBe('total_cap');
    });
  });

  describe('the demo share', () => {
    it('lets demo mail use at most 20 percent of a stage-1 day, and other mail the rest', () => {
      const l = lane();
      for (let i = 0; i < 10; i += 1) {
        expect(send(l, `d${i}@example.com`, true)).toBe(true);
      }
      expect(reasonOf(l, 'd10@example.com', true)).toBe('demo_cap');
      for (let i = 0; i < 40; i += 1) {
        expect(send(l, `n${i}@example.com`)).toBe(true);
      }
      expect(reasonOf(l, 'n40@example.com')).toBe('total_cap');
    });

    it('lets demo mail use at most 20 percent of a stage-2 day', () => {
      writeState({ stage: 2, held: false, destinationHolds: [] });
      const l = lane();
      for (let i = 0; i < 20; i += 1) {
        expect(send(l, `d${i}@example.com`, true)).toBe(true);
      }
      expect(reasonOf(l, 'd20@example.com', true)).toBe('demo_cap');
    });

    it('lets demo mail use the whole day from stage 3', () => {
      writeState({ stage: 3, held: false, destinationHolds: [] });
      const l = lane();
      for (let i = 0; i < 200; i += 1) {
        expect(send(l, `d${i}@example.com`, true)).toBe(true);
      }
      expect(reasonOf(l, 'd200@example.com', true)).toBe('total_cap');
    });

    it('counts demo mail to Gmail against the Gmail cap too', () => {
      writeState({ stage: 3, held: false, destinationHolds: [] });
      const l = lane();
      for (let i = 0; i < 100; i += 1) {
        expect(send(l, `d${i}@gmail.com`, true)).toBe(true);
      }
      expect(reasonOf(l, 'x@gmail.com', true)).toBe('destination_cap');
    });
  });

  describe('a place, once taken', () => {
    it('is taken once however often the message is offered', () => {
      const l = lane();
      const message = { id: 'same', to: 'a@gmail.com', demo: false };
      expect(l.reserve(message).ok).toBe(true);
      expect(l.reserve(message).ok).toBe(true);
      expect(ip2State(l).sentToday).toBe(1);
    });

    it('is still refused by the hold when the message already has one', () => {
      const l = lane();
      const message = { id: 'same', to: 'a@example.com', demo: false };
      l.reserve(message);
      writeState({ stage: 1, held: true, destinationHolds: [] });
      expect(l.reserve(message)).toEqual({ ok: false, reason: 'held' });
    });

    it('is given back when the submission definitely took nothing', () => {
      const l = lane();
      const decision = l.reserve({ id: 'a', to: 'a@gmail.com', demo: true });
      if (!decision.ok) {
        throw new Error('expected a place');
      }
      decision.slot.settle('not-sent');
      expect(ip2State(l).sentToday).toBe(0);
      const after = JSON.parse(readFileSync(counterPath, 'utf8')) as {
        total: number;
        demo: number;
        destinations: { gmail: number };
        ids: string[];
      };
      expect(after).toMatchObject({ total: 0, demo: 0, destinations: { gmail: 0 }, ids: [] });
    });

    it('stays used when the submission may have been taken', () => {
      const l = lane();
      const decision = l.reserve({ id: 'a', to: 'a@example.com', demo: false });
      if (!decision.ok) {
        throw new Error('expected a place');
      }
      decision.slot.settle('accepted');
      decision.slot.settle('not-sent');
      expect(ip2State(l).sentToday).toBe(1);
    });
  });
});

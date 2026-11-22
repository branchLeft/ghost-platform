import { describe, expect, it } from 'vitest';
import {
  applyColourSwitch,
  rollbackColour,
  switchColour,
  type Colour,
  type SwitchPlan,
} from '../../src/colourSwitch.js';
import { FakeColourHost, type Fault, type Method } from './helpers/fakeColourHost.js';

const NEW_IMAGE = 'registry.example/ghost@sha256:' + 'b'.repeat(64);
const OLD_IMAGE = 'registry.example/ghost@sha256:' + 'a'.repeat(64);

function plan(from: Colour): SwitchPlan {
  return {
    from,
    to: from === 'a' ? 'b' : 'a',
    image: NEW_IMAGE,
    restoreImage: OLD_IMAGE,
  };
}

const FAULTS: readonly { method: Method; mode: Fault['mode'] }[] = [
  { method: 'prepare', mode: 'throw' },
  { method: 'prepare', mode: 'fail' },
  { method: 'runningColours', mode: 'throw' },
  { method: 'stop', mode: 'throw' },
  { method: 'stop', mode: 'linger' },
  { method: 'start', mode: 'throw' },
  { method: 'start', mode: 'fail' },
];

describe('the Mode A switch: the happy path', () => {
  it('pulls and checks the new colour while the old one runs, then stops the old, then starts the new', async () => {
    const host = new FakeColourHost(['a']);
    const result = await applyColourSwitch(host, plan('a'));
    expect(result).toEqual({ ok: true });

    const prepare = host.calls.find((c) => c.method === 'prepare');
    expect(prepare).toMatchObject({ colour: 'b', image: NEW_IMAGE, aliveBefore: ['a'] });

    const order = host.calls.filter((c) => c.method === 'stop' || c.method === 'start');
    expect(order.map((c) => `${c.method} ${c.colour}`)).toEqual(['stop a', 'start b']);
    expect(order[1]?.aliveBefore).toEqual([]);
    expect([...host.alive]).toEqual(['b']);
    expect(host.neverTwo()).toBe(true);
  });

  it('rollback is the same switch the other way, onto the image the old colour ran', async () => {
    const host = new FakeColourHost(['a']);
    await applyColourSwitch(host, plan('a'));
    const back = await rollbackColour(host, plan('a'));
    expect(back).toEqual({ ok: true, running: 'a' });
    const last = host.calls.filter((c) => c.method === 'start').at(-1);
    expect(last).toMatchObject({ colour: 'a', image: OLD_IMAGE, aliveBefore: [] });
    expect([...host.alive]).toEqual(['a']);
    expect(host.neverTwo()).toBe(true);
  });

  it('works in both directions', async () => {
    const host = new FakeColourHost(['b']);
    expect(await applyColourSwitch(host, plan('b'))).toEqual({ ok: true });
    expect([...host.alive]).toEqual(['a']);
    expect(host.neverTwo()).toBe(true);
  });
});

describe('the Mode A switch: no window with two Ghosts, under every fault', () => {
  async function callCounts(from: Colour): Promise<Record<Method, number>> {
    const clean = new FakeColourHost([from]);
    await applyColourSwitch(clean, plan(from));
    await rollbackColour(clean, plan(from));
    return {
      prepare: clean.count('prepare'),
      runningColours: clean.count('runningColours'),
      stop: clean.count('stop'),
      start: clean.count('start'),
    };
  }

  it.each(['a', 'b'] as const)(
    'from %s: a fault on any call of the switch and its rollback never puts two Ghosts up',
    async (from) => {
      const counts = await callCounts(from);
      let runs = 0;
      for (const { method, mode } of FAULTS) {
        for (let nth = 1; nth <= counts[method]; nth += 1) {
          const host = new FakeColourHost([from], { fault: { method, nth, mode } });
          await applyColourSwitch(host, plan(from));
          await rollbackColour(host, plan(from));
          await switchColour(host, plan(from));
          const label = `${method} ${mode} on call ${nth}`;
          expect(host.peak, label).toBeLessThanOrEqual(1);
          expect(host.overlapStarts, label).toEqual([]);
          runs += 1;
        }
      }
      expect(runs).toBeGreaterThan(10);
    }
  );

  it('a new image that never gets healthy is stopped, then the old colour is put back, never both', async () => {
    const host = new FakeColourHost(['a'], { brokenStart: ['b'] });
    const result = await switchColour(host, plan('a'));
    expect(result).toEqual({
      ok: false,
      reason: 'b never became healthy',
      running: ['a'],
      restored: true,
    });
    const starts = host.calls.filter((c) => c.method === 'start');
    expect(starts.map((c) => `${c.colour} ${c.image}`)).toEqual([
      `b ${NEW_IMAGE}`,
      `a ${OLD_IMAGE}`,
    ]);
    expect(starts[1]?.aliveBefore).toEqual([]);
    expect(host.neverTwo()).toBe(true);
  });

  it('a stop that returns while the process lives starts nothing, and says so', async () => {
    const host = new FakeColourHost(['a'], { fault: { method: 'stop', nth: 1, mode: 'linger' } });
    const result = await switchColour(host, plan('a'));
    expect(result).toMatchObject({ ok: false, running: ['a'], restored: false });
    expect(host.calls.some((c) => c.method === 'start')).toBe(false);
    expect(host.neverTwo()).toBe(true);
  });

  it('a host that cannot be read changes nothing', async () => {
    const host = new FakeColourHost(['a'], {
      fault: { method: 'runningColours', nth: 1, mode: 'throw' },
    });
    const result = await switchColour(host, plan('a'));
    expect(result.ok).toBe(false);
    expect(host.calls.some((c) => c.method === 'stop' || c.method === 'start')).toBe(false);
  });

  it('refuses when both colours are already running, and touches nothing', async () => {
    const host = new FakeColourHost(['a', 'b']);
    const result = await switchColour(host, plan('a'));
    expect(result).toMatchObject({ ok: false, running: ['a', 'b'], restored: false });
    expect(result.ok === false && result.reason).toContain('both colours are running');
    expect(host.calls.some((c) => c.method === 'stop' || c.method === 'start')).toBe(false);
  });

  it('a failed prepare leaves the old colour running and stops nothing', async () => {
    const host = new FakeColourHost(['a'], { fault: { method: 'prepare', nth: 1, mode: 'fail' } });
    const result = await applyColourSwitch(host, plan('a'));
    expect(result.ok).toBe(false);
    expect([...host.alive]).toEqual(['a']);
    expect(host.calls.some((c) => c.method === 'stop' || c.method === 'start')).toBe(false);
  });

  it('is safe to run again after a crash: already switched is a no-op, nothing running starts the new colour', async () => {
    const switched = new FakeColourHost(['b']);
    expect(await switchColour(switched, plan('a'))).toEqual({ ok: true, running: 'b' });
    expect(switched.calls.filter((c) => c.method === 'stop' || c.method === 'start')).toEqual([]);

    const empty = new FakeColourHost([]);
    expect(await switchColour(empty, plan('a'))).toEqual({ ok: true, running: 'b' });
    expect(empty.neverTwo()).toBe(true);
  });

  it('a restore that also fails is reported with what is left running, and the failure is not hidden', async () => {
    const host = new FakeColourHost(['a'], { brokenStart: ['a', 'b'] });
    const result = await switchColour(host, plan('a'));
    expect(result).toMatchObject({ ok: false, running: ['a'], restored: false });
    expect(result.ok === false && result.reason).toContain('restoring a failed');
    expect(host.neverTwo()).toBe(true);
  });

  it('a new colour that cannot be confirmed stopped is not followed by a start of the old one', async () => {
    const host = new FakeColourHost(['a'], {
      brokenStart: ['b'],
      fault: { method: 'stop', nth: 2, mode: 'linger' },
    });
    const result = await switchColour(host, plan('a'));
    expect(result).toMatchObject({ ok: false, running: ['b'], restored: false });
    expect(host.calls.filter((c) => c.method === 'start')).toHaveLength(1);
    expect(host.neverTwo()).toBe(true);
  });

  it('a host that cannot be read just before the start is not started on, and the old colour is put back', async () => {
    const host = new FakeColourHost(['a'], {
      fault: { method: 'runningColours', nth: 3, mode: 'throw' },
    });
    const result = await switchColour(host, plan('a'));
    expect(result).toMatchObject({ ok: false, restored: true });
    expect(host.calls.filter((c) => c.method === 'start').map((c) => c.colour)).toEqual(['a']);
    expect([...host.alive]).toEqual(['a']);
    expect(host.neverTwo()).toBe(true);
  });

  it('a stop that throws but leaves no process still counts as stopped', async () => {
    const host = new FakeColourHost(['a'], { fault: { method: 'stop', nth: 1, mode: 'throw' } });
    host.alive.clear();
    const result = await switchColour(host, plan('a'));
    expect(result).toEqual({ ok: true, running: 'b' });
  });

  it('refuses to switch a colour to itself', async () => {
    const host = new FakeColourHost(['a']);
    const result = await switchColour(host, { ...plan('a'), to: 'a' });
    expect(result.ok).toBe(false);
    expect(host.calls.some((c) => c.method === 'stop' || c.method === 'start')).toBe(false);
  });
});

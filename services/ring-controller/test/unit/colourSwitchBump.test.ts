import { describe, expect, it, vi } from 'vitest';
import { createApplyLock } from '../../src/applyLock.js';
import { BumpStateMachine, type BumpDependencies } from '../../src/bumpStateMachine.js';
import { colourSwitchDependencies, type SwitchPlan } from '../../src/colourSwitch.js';
import { FakeColourHost, type FakeOptions } from './helpers/fakeColourHost.js';

const PLAN: SwitchPlan = { from: 'a', to: 'b', image: 'new-image', restoreImage: 'old-image' };

function machine(
  host: FakeColourHost,
  overrides: Partial<BumpDependencies> = {}
): { machine: BumpStateMachine; deps: BumpDependencies } {
  const deps: BumpDependencies = {
    backup: vi.fn(async () => ({ ok: true })),
    awaitApplySettled: vi.fn(async () => ({ ok: true })),
    verify: vi.fn(async () => ({ ok: true })),
    page: vi.fn(async () => undefined),
    ...colourSwitchDependencies(host, PLAN),
    ...overrides,
  };
  return { machine: new BumpStateMachine(deps, createApplyLock(), { bumpId: 'bump-1' }), deps };
}

async function live(options: FakeOptions = {}): Promise<FakeColourHost> {
  return new FakeColourHost(['a'], options);
}

describe('a whole bump on Mode A never has two Ghosts', () => {
  it('a clean bump ends on the new colour, and closing the bake window leaves it alone', async () => {
    const host = await live();
    const { machine: m } = machine(host);
    expect(await m.run()).toBe('done');
    expect([...host.alive]).toEqual(['b']);
    expect(await m.closeBakeWindow()).toBe('closed');
    expect([...host.alive]).toEqual(['b']);
    expect(host.neverTwo()).toBe(true);
  });

  it('a new colour that fails verification is switched back to the old one', async () => {
    const host = await live();
    const { machine: m, deps } = machine(host, { verify: vi.fn(async () => ({ ok: false })) });
    expect(await m.run()).toBe('reverted');
    expect([...host.alive]).toEqual(['a']);
    expect(deps.page).not.toHaveBeenCalled();
    expect(host.neverTwo()).toBe(true);
  });

  it('an abort during the bake window switches back, one colour at every instant', async () => {
    const host = await live();
    const { machine: m } = machine(host);
    await m.run();
    expect(await m.abortAfterDone()).toBe('reverted');
    expect([...host.alive]).toEqual(['a']);
    expect(host.neverTwo()).toBe(true);
  });

  it('an image that never gets healthy is put back by the switch itself, and the bump reverts', async () => {
    const host = await live({ brokenStart: ['b'] });
    const { machine: m } = machine(host);
    expect(await m.run()).toBe('reverted');
    expect([...host.alive]).toEqual(['a']);
    expect(host.neverTwo()).toBe(true);
  });

  it('a host that cannot stop the old colour leaves it serving and never starts the new one', async () => {
    const host = await live({ fault: { method: 'stop', nth: 1, mode: 'linger' } });
    const { machine: m, deps } = machine(host);
    expect(await m.run()).toBe('reverted');
    expect(deps.page).not.toHaveBeenCalled();
    expect([...host.alive]).toEqual(['a']);
    expect(host.calls.some((c) => c.method === 'start')).toBe(false);
    expect(host.neverTwo()).toBe(true);
  });

  it('stopping a colour that is already down is a no-op', async () => {
    const host = await live();
    const deps = colourSwitchDependencies(host, PLAN);
    await deps.stopColour('new');
    expect(host.calls.some((c) => c.method === 'stop')).toBe(false);
    await deps.stopColour('old');
    expect([...host.alive]).toEqual([]);
  });

  it('stopping a colour that cannot be confirmed down throws, so recovery pages', async () => {
    const host = await live({ fault: { method: 'stop', nth: 1, mode: 'linger' } });
    const deps = colourSwitchDependencies(host, PLAN);
    await expect(deps.stopColour('old')).rejects.toThrow(/still has a process/);
  });
});

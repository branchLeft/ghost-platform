/**
 * Sabotage pairs for the Mode A colour switch. Each breaks real lines of
 * `src/colourSwitch.ts` in a throwaway copy, asserts the property FAILS on
 * that copy, then asserts it HOLDS on the real module. A property that held
 * on both would prove nothing about the lines.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as real from '../../src/colourSwitch.js';
import type { SwitchPlan } from '../../src/colourSwitch.js';
import { FakeColourHost, type FakeOptions } from './helpers/fakeColourHost.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = Pick<typeof real, 'applyColourSwitch' | 'switchColour'>;

afterAll(() => {
  cleanupSabotageTmp();
});

const PLAN: SwitchPlan = { from: 'a', to: 'b', image: 'new-image', restoreImage: 'old-image' };

const sabotaged = (...mutations: Mutation[]) =>
  importSabotaged<Module>('colourSwitch.ts', mutations);

async function expectPair(
  mutations: Mutation[],
  scenario: (mod: Module) => Promise<boolean>
): Promise<void> {
  expect(await scenario(await sabotaged(...mutations))).toBe(false);
  expect(await scenario(real)).toBe(true);
}

/** The old colour is never stopped: the start of the new one has nothing in the way but the guard. */
const skipTheStop: Mutation = {
  file: 'colourSwitch.ts',
  find: 'if (before[0] === from) {',
  replace: 'if (false) {',
};

/** Every start goes ahead whatever the host reports. */
const dropTheGuard: Mutation = {
  file: 'colourSwitch.ts',
  find: 'if (up.some((running) => running !== colour)) {',
  replace: 'if (false) {',
};

/** A stop is taken at its word, with no read of the host to confirm the process is gone. */
const trustTheStop: Mutation = {
  file: 'colourSwitch.ts',
  find: 'if (up.includes(colour)) {',
  replace: 'if (false) {',
};

/** The new image is prepared only after the switch, when the old colour is already down. */
const prepareAfterSwitch: Mutation = {
  file: 'colourSwitch.ts',
  find: 'prepared = await host.prepare(plan.to, plan.image);',
  replace: 'await switchColour(host, plan); prepared = await host.prepare(plan.to, plan.image);',
};

async function drive(mod: Module, options: FakeOptions = {}): Promise<FakeColourHost> {
  const host = new FakeColourHost(['a'], options);
  await mod.applyColourSwitch(host, PLAN);
  return host;
}

describe('the colour switch: source-mutation sabotage', () => {
  it('overlap: a switch that starts the new colour beside the old puts two Ghosts up', async () => {
    await expectPair([skipTheStop, dropTheGuard], async (mod) => (await drive(mod)).neverTwo());
  });

  it('the stop is real: without it the switch never reaches the new colour', async () => {
    await expectPair([skipTheStop], async (mod) => {
      const host = await drive(mod);
      return host.neverTwo() && [...host.alive].join() === 'b';
    });
  });

  it('a stop that lies is caught: trusting it starts the new colour beside the lingering old one', async () => {
    const lingering: FakeOptions = { fault: { method: 'stop', nth: 1, mode: 'linger' } };
    await expectPair([trustTheStop, dropTheGuard], async (mod) =>
      (await drive(mod, lingering)).neverTwo()
    );
  });

  it('the new image is prepared while the old colour runs, not after it has stopped', async () => {
    await expectPair([prepareAfterSwitch], async (mod) => {
      const host = await drive(mod);
      const prepare = host.calls.find((call) => call.method === 'prepare');
      return prepare?.aliveBefore.join() === 'a';
    });
  });
});

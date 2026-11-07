import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShell } from '../src/shell/app.js';
import {
  concurrentCallbacks,
  floodOutcome,
  LIMIT,
  type CreateShell,
  type FloodOutcome,
} from './clientLimitRig.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

interface ShellModule {
  readonly createShell: CreateShell;
}

const LIMIT_SOURCE = 'shell/clientLimit.ts';
const SHELL_SOURCE = 'shell/app.ts';
const WIRING = "from '../../src/shell/clientLimit.js'";

/** The shell, with its client limit replaced by a copy of that module with one text changed. */
async function shellWithLimit(
  name: string,
  target: string,
  replacement: string
): Promise<CreateShell> {
  await importSabotaged(name, target, replacement, LIMIT_SOURCE);
  const mutant = await importSabotaged<ShellModule>(
    `shell-on-${name}`,
    WIRING,
    `from './${name}.js'`,
    SHELL_SOURCE
  );
  return mutant.createShell;
}

beforeAll(clearMutants);
afterAll(clearMutants);

const expectHealthy = (outcome: FloodOutcome): void => {
  expect(outcome.firstThirtyLoginsAllStarted).toBe(true);
  expect(outcome.thirtyFirstLogin.status).toBe(429);
  expect(outcome.otherClientLogin.status).toBe(302);
  expect(outcome.firstThirtyCallbacksAllReachedTheIssuer).toBe(true);
  expect(outcome.thirtyFirstCallback.status).toBe(429);
  expect(outcome.tokenCallsByThirtyFirstCallback).toBe(0);
};

describe('sabotage: the helper', () => {
  it('refuses a mutation that changes nothing', async () => {
    await expect(
      importSabotaged('noop', 'text that is not in the module', 'x', LIMIT_SOURCE)
    ).rejects.toThrow('exactly once');
  });
});

describe('sabotage: the check on starting a sign-in is what refuses a flood', () => {
  it('RED: with the check dropped, the thirty-first start is let through', async () => {
    const create = await shellWithLimit(
      'login-check-dropped',
      'logins.attempt(keyOf(request), nowMs)',
      '({ allowed: true })'
    );
    const outcome = await floodOutcome(create);
    expect(outcome.thirtyFirstLogin.status).toBe(302);
    expect(outcome.thirtyFirstLogin.retryAfter).toBeNull();
    // The callback check was left alone and still holds.
    expect(outcome.thirtyFirstCallback.status).toBe(429);
  });

  it('GREEN: the real shell refuses it', async () => {
    expectHealthy(await floodOutcome(createShell));
  });
});

describe('sabotage: the check on the callback is what keeps a flood off the token endpoint', () => {
  it('RED: with the check dropped, the thirty-first callback reaches the token endpoint', async () => {
    const create = await shellWithLimit(
      'callback-check-dropped',
      'callbacks.attempt(keyOf(request), nowMs)',
      '({ allowed: true })'
    );
    const outcome = await floodOutcome(create);
    expect(outcome.thirtyFirstCallback.status).not.toBe(429);
    expect(outcome.tokenCallsByThirtyFirstCallback).toBe(1);
    expect(outcome.thirtyFirstLogin.status).toBe(429);
  });

  it('GREEN: the real shell refuses it before the token endpoint is called', async () => {
    expectHealthy(await floodOutcome(createShell));
  });
});

describe('sabotage: keying on the verified client address is what spares the other clients', () => {
  it('RED: keyed on the edge alone, one client’s flood refuses a different client', async () => {
    const create = await shellWithLimit(
      'key-on-the-edge',
      "request.headers['x-forwarded-for']",
      'undefined'
    );
    const outcome = await floodOutcome(create);
    expect(outcome.thirtyFirstLogin.status).toBe(429);
    expect(outcome.otherClientLogin.status).toBe(429);
  });

  it('GREEN: the real shell keeps the other client admitted', async () => {
    expect((await floodOutcome(createShell)).otherClientLogin.status).toBe(302);
  });
});

describe('sabotage: the shell’s own refusal is what turns a spent allowance into a 429', () => {
  it('RED: with the refusal removed from the shell, nothing is ever refused', async () => {
    const mutant = await importSabotaged<ShellModule>(
      'shell-never-refuses',
      'if (!verdict.allowed) {',
      'if (verdict.allowed === undefined) {',
      SHELL_SOURCE
    );
    const outcome = await floodOutcome(mutant.createShell);
    expect(outcome.thirtyFirstLogin.status).toBe(302);
    expect(outcome.thirtyFirstCallback.status).not.toBe(429);
  });

  it('GREEN: the real shell refuses both', async () => {
    expectHealthy(await floodOutcome(createShell));
    expect(LIMIT).toBe(30);
  });
});

describe('sabotage: the claim after the token is verified is what stops a sign-in finishing twice', () => {
  it('RED: without the check for a spent sign-in, both callbacks open a session', async () => {
    const mutant = await importSabotaged<ShellModule>(
      'shell-spent-check-removed',
      "if (claim === 'spent') {",
      "if (claim === 'never') {",
      SHELL_SOURCE
    );
    const answers = await concurrentCallbacks(mutant.createShell);
    expect(answers.map((answer) => answer.status)).toEqual([302, 302]);
  });

  it('GREEN: the real shell opens one and refuses the other', async () => {
    const answers = await concurrentCallbacks(createShell);
    expect(answers.map((answer) => answer.status).sort()).toEqual([302, 400]);
  });
});

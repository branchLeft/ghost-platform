import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShell } from '../src/shell/app.js';
import { parseTrustedProxies } from 'ghost-platform-request-guard/dist/index.js';
import {
  CLIENT_BROAD_LIMIT,
  CLIENT_BROAD_TABLE_SIZE,
  createClientLimit,
} from '../src/shell/clientLimit.js';
import {
  concurrentCallbacks,
  EDGE,
  floodOutcome,
  inBlock,
  LIMIT,
  requestFrom,
  rotateAcrossOneBlock,
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
      'meter(logins, request, nowMs)',
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
      'meter(callbacks, request, nowMs)',
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

interface LimitModule {
  readonly createClientLimit: typeof createClientLimit;
}

const limitWith = (name: string, target: string, replacement: string): Promise<LimitModule> =>
  importSabotaged<LimitModule>(name, target, replacement, LIMIT_SOURCE);

describe('sabotage: the broad /48 tier is what stops a client rotating through its /64s', () => {
  const REQUESTS = CLIENT_BROAD_LIMIT + 5;

  it('RED: with the broad key dropped, every rotated /64 is let through', async () => {
    const mutant = await limitWith(
      'broad-tier-dropped',
      'const broad = broadKey !== null && broadKey !== key ? broadKey : null;',
      'const broad = null;'
    );
    expect(rotateAcrossOneBlock(mutant.createClientLimit, REQUESTS).every(Boolean)).toBe(true);
  });

  it('GREEN: the real limiter refuses once the /48 is spent', () => {
    const verdicts = rotateAcrossOneBlock(createClientLimit, REQUESTS);
    expect(verdicts.filter(Boolean)).toHaveLength(CLIENT_BROAD_LIMIT);
  });

  it('RED: with the broad ceiling counting nothing, every rotated /64 is let through', async () => {
    const mutant = await limitWith(
      'broad-never-charged',
      'if (broad !== null) tiers.broad.attempt(broad, nowMs);',
      ''
    );
    expect(rotateAcrossOneBlock(mutant.createClientLimit, REQUESTS).every(Boolean)).toBe(true);
  });

  it('GREEN: the real limiter charges the broad ceiling', () => {
    expect(rotateAcrossOneBlock(createClientLimit, REQUESTS)[CLIENT_BROAD_LIMIT]).toBe(false);
  });
});

describe('sabotage: refusing when the /48 table is full is what keeps its counts', () => {
  /** Spends one /48 to its ceiling, fills the broad table with others, then asks again. */
  const spentBlockAfterAFlood = (create: typeof createClientLimit): boolean => {
    const limit = create({ trustedProxies: parseTrustedProxies(EDGE) });
    for (let index = 0; index < CLIENT_BROAD_LIMIT; index += 1) {
      limit.login(requestFrom(inBlock(0xaaaa, index + 1)), 0);
    }
    for (let index = 0; index < CLIENT_BROAD_TABLE_SIZE; index += 1) {
      const high = Math.floor(index / 65_536).toString(16);
      limit.login(requestFrom(`2001:${high}:${(index % 65_536).toString(16)}::1`), 1);
    }
    return limit.login(requestFrom(inBlock(0xaaaa, 9_999)), 2).allowed;
  };

  it('RED: with the broad table evicting, a flood of /48s resets the spent one', async () => {
    const mutant = await limitWith(
      'broad-table-evicts',
      "onFull: 'refuse',",
      "onFull: 'evict-oldest',"
    );
    expect(spentBlockAfterAFlood(mutant.createClientLimit)).toBe(true);
  });

  it('GREEN: the real limiter still refuses the spent /48', () => {
    expect(spentBlockAfterAFlood(createClientLimit)).toBe(false);
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

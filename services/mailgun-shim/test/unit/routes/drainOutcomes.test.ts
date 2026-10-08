import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainRouter } from '../../../src/routes/drain.js';
import { createDrainWake } from '../../../src/drainWake.js';
import { createTestLogger } from '../../helpers/testLogger.js';
import { createUnlimitedThrottle } from '../../helpers/testThrottle.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { startRouter, type StartedRouter } from '../helpers/startRouter.js';

const TOKEN = 'the-drain-token';
const OPTIONS = { holdMs: 50, leaseSeconds: 30, batchLimit: 10, pollIntervalMs: 10 };

describe('POST /drain/outcomes', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  async function start(outcomesEnabled?: boolean): Promise<void> {
    server = await startRouter(
      createDrainRouter(
        store,
        createDrainWake(),
        TOKEN,
        { ...OPTIONS, ...(outcomesEnabled === undefined ? {} : { outcomesEnabled }) },
        createTestLogger().logger,
        createUnlimitedThrottle()
      )
    );
  }

  function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
    return fetch(`${server.baseUrl}/drain/outcomes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    store = createFakeStore();
  });

  afterEach(async () => {
    await server.close();
  });

  it('is not served at all unless explicitly enabled (404), whatever the body', async () => {
    await start();
    const res = await post({ outcomes: [{ id: 'a', drainCount: 1, outcome: 'delivered' }] });
    expect(res.status).toBe(404);
    expect(store.outcomeCalls).toEqual([]);
  });

  it('stays off when enabled is explicitly false', async () => {
    await start(false);
    expect((await post({ outcomes: [] })).status).toBe(404);
  });

  it('401s without the drain token and records nothing', async () => {
    await start(true);
    const res = await post({ outcomes: [{ id: 'a', drainCount: 1, outcome: 'delivered' }] }, null);
    expect(res.status).toBe(401);
    expect(store.outcomeCalls).toEqual([]);
  });

  it('passes a well-formed batch to the store and returns its result', async () => {
    await start(true);
    const res = await post({
      outcomes: [
        { id: 'a', drainCount: 1, outcome: 'delivered' },
        {
          id: 'b',
          drainCount: 2,
          outcome: 'failed',
          severity: 'permanent',
          code: 550,
          message: 'gone',
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: ['a', 'b'], alreadyHandled: [], unknown: [] });
    expect(store.outcomeCalls[0]).toEqual([
      { id: 'a', drainCount: 1, outcome: 'delivered' },
      {
        id: 'b',
        drainCount: 2,
        outcome: 'failed',
        severity: 'permanent',
        code: 550,
        message: 'gone',
      },
    ]);
  });

  it.each([
    ['no body object', 'x'],
    ['an empty list', { outcomes: [] }],
    ['a non-array list', { outcomes: 'x' }],
    ['a missing id', { outcomes: [{ drainCount: 1, outcome: 'delivered' }] }],
    ['a zero drainCount', { outcomes: [{ id: 'a', drainCount: 0, outcome: 'delivered' }] }],
    ['an unknown outcome', { outcomes: [{ id: 'a', drainCount: 1, outcome: 'opened' }] }],
    [
      'a failed outcome with no severity',
      { outcomes: [{ id: 'a', drainCount: 1, outcome: 'failed' }] },
    ],
    [
      'a non-integer code',
      { outcomes: [{ id: 'a', drainCount: 1, outcome: 'delivered', code: 'x' }] },
    ],
    [
      'a non-string message',
      { outcomes: [{ id: 'a', drainCount: 1, outcome: 'delivered', message: 3 }] },
    ],
    ['a non-object entry', { outcomes: [null] }],
    [
      'too many entries',
      {
        outcomes: Array.from({ length: 201 }, (_, i) => ({
          id: `${i}`,
          drainCount: 1,
          outcome: 'delivered',
        })),
      },
    ],
  ])('400s %s and records nothing', async (_name, body) => {
    await start(true);
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(store.outcomeCalls).toEqual([]);
  });

  it('truncates an overlong message rather than storing it whole', async () => {
    await start(true);
    await post({
      outcomes: [{ id: 'a', drainCount: 1, outcome: 'delivered', message: 'x'.repeat(900) }],
    });
    expect(store.outcomeCalls[0]![0]!.message).toHaveLength(500);
  });
});

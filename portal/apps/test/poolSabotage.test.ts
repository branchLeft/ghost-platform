import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortalPool } from '../src/shell/pool.js';
import {
  connectTimeout,
  errorCode,
  exhaustedPool,
  idleClientKilled,
  idleInTransaction,
  statementTimeout,
  type CreatePool,
} from './poolScenarios.js';
import { clearMutants, importSabotaged, POOL } from './sourceSabotage.js';

interface PoolModule {
  readonly createPortalPool: CreatePool;
}

const broken = (name: string, target: string, replacement = ''): Promise<PoolModule> =>
  importSabotaged<PoolModule>(name, target, replacement, POOL);

beforeAll(clearMutants);
afterAll(clearMutants);

describe('sabotage: the pool settings are what bound a stalled database', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(broken('noop', 'text that is not in the module', 'x')).rejects.toThrow(
      'exactly once'
    );
  });

  it('RED: without statement_timeout a long statement runs to the end, GREEN: the real pool cancels it', async () => {
    const module = await broken('no-statement-timeout', 'statement_timeout: timeouts.statementMs,');
    const red = await statementTimeout(module.createPortalPool);
    expect(red.attempt.settled).toBe(false);

    const green = await statementTimeout(createPortalPool);
    expect(green.attempt.settled).toBe(true);
    expect(errorCode(green.attempt.error)).toBe('57014');
  });

  it('RED: without connectionTimeoutMillis a silent database holds the sign-in, GREEN: the real pool gives up', async () => {
    const module = await broken(
      'no-connect-timeout',
      'connectionTimeoutMillis: timeouts.connectMs,'
    );
    expect((await connectTimeout(module.createPortalPool)).attempt.settled).toBe(false);
    expect((await connectTimeout(createPortalPool)).attempt.settled).toBe(true);
  });

  it('RED: without connectionTimeoutMillis an exhausted pool queues for ever, GREEN: the real pool rejects', async () => {
    const module = await broken(
      'no-exhausted-timeout',
      'connectionTimeoutMillis: timeouts.connectMs,'
    );
    expect((await exhaustedPool(module.createPortalPool)).attempt.settled).toBe(false);
    expect((await exhaustedPool(createPortalPool)).attempt.settled).toBe(true);
  });

  it('RED: without idle_in_transaction_session_timeout the server never ends the idle transaction', async () => {
    const module = await broken(
      'no-idle-in-transaction-timeout',
      'idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,'
    );
    const red = await idleInTransaction(module.createPortalPool);
    expect(red.nextStatementFailed).toBe(false);
    expect(red.lines).toEqual([]);

    const green = await idleInTransaction(createPortalPool);
    expect(green.nextStatementFailed).toBe(true);
  });
});

describe('sabotage: the error listeners are what keep a server-ended client from ending the process', () => {
  it('RED: with the pool listener alone, the idle-in-transaction kill of a checked-out client is still an uncaught exception', async () => {
    const module = await broken(
      'no-client-listener',
      "pool.on('connect', (client) => client.on('error', report));"
    );
    const red = await idleInTransaction(module.createPortalPool);
    expect(red.uncaught.length).toBeGreaterThanOrEqual(1);
    expect(errorCode(red.uncaught[0])).toBe('25P03');
    expect(red.lines).toEqual([]);

    const green = await idleInTransaction(createPortalPool);
    expect(green.uncaught).toEqual([]);
    expect(green.lines.length).toBeGreaterThanOrEqual(1);
  });

  it('RED: with neither listener a terminated idle connection is an uncaught exception, GREEN: the real pool logs it', async () => {
    const module = await broken(
      'no-listeners',
      "pool.on('error', report);\n  pool.on('connect', (client) => client.on('error', report));",
      ''
    );
    const red = await idleClientKilled(module.createPortalPool);
    expect(red.uncaught.length).toBeGreaterThanOrEqual(1);
    expect(errorCode(red.uncaught[0])).toBe('57P01');
    expect(red.lines).toEqual([]);

    const green = await idleClientKilled(createPortalPool);
    expect(green.uncaught).toEqual([]);
    expect(green.lines).toHaveLength(1);
  });
});

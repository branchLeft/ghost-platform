import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { inTransaction } from '../src/db.js';

function fakePool(failOn?: (sql: string) => boolean) {
  const log: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) {
      log.push(sql);
      if (failOn?.(sql)) throw new Error(`failed: ${sql}`);
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  } as unknown as PoolClient;
  return { pool: { connect: async () => client }, log, released: () => released };
}

describe('inTransaction', () => {
  it('prepares, works, commits and releases', async () => {
    const { pool, log, released } = fakePool();
    const out = await inTransaction(
      pool,
      async (c) => void (await c.query('PREPARE')),
      async (c) => {
        await c.query('WORK');
        return 5;
      }
    );
    expect(out).toBe(5);
    expect(log).toEqual(['BEGIN', 'PREPARE', 'WORK', 'COMMIT']);
    expect(released()).toBe(1);
  });

  it('rolls back and releases when the work fails', async () => {
    const { pool, log, released } = fakePool((sql) => sql === 'WORK');
    await expect(
      inTransaction(
        pool,
        async () => undefined,
        async (c) => void (await c.query('WORK'))
      )
    ).rejects.toThrow('failed: WORK');
    expect(log).toEqual(['BEGIN', 'WORK', 'ROLLBACK']);
    expect(released()).toBe(1);
  });

  it('never runs the work when preparing fails', async () => {
    const { pool, log } = fakePool();
    await expect(
      inTransaction(
        pool,
        async () => {
          throw new Error('no binding');
        },
        async (c) => void (await c.query('WORK'))
      )
    ).rejects.toThrow('no binding');
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('reports the original error when the rollback also fails', async () => {
    const { pool, released } = fakePool((sql) => sql === 'WORK' || sql === 'ROLLBACK');
    await expect(
      inTransaction(
        pool,
        async () => undefined,
        async (c) => void (await c.query('WORK'))
      )
    ).rejects.toThrow('failed: WORK');
    expect(released()).toBe(1);
  });

  it('releases the connection when BEGIN fails', async () => {
    const { pool, released } = fakePool((sql) => sql === 'BEGIN');
    await expect(
      inTransaction(
        pool,
        async () => undefined,
        async () => 1
      )
    ).rejects.toThrow('failed: BEGIN');
    expect(released()).toBe(1);
  });
});

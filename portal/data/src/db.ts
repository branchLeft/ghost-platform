import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/** The slice of `pg.Pool` this layer needs; a pool satisfies it. */
export interface Connectable {
  connect(): Promise<PoolClient>;
}

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<R>>;
};

/**
 * Runs `work` inside one transaction on one connection. `prepare` runs first
 * in that transaction, so whatever it sets (a role, a bound tenant) holds for
 * exactly the statements of `work` and is gone at commit or rollback; a
 * pooled connection never carries it to the next caller.
 */
export async function inTransaction<T>(
  pool: Connectable,
  prepare: (client: PoolClient) => Promise<void>,
  work: (client: Queryable) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await prepare(client);
      const result = await work({
        query: (sql, params) => client.query(sql, params as unknown[]),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

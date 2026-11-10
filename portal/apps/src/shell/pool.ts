import pg from 'pg';
import { portalErrorLine } from './errorLine.js';

export interface PoolTimeouts {
  /** Opening a connection, and waiting for a free client when the pool is exhausted. */
  readonly connectMs: number;
  /** The server cancels any one statement that runs longer than this. */
  readonly statementMs: number;
  /** The server ends a session that sits idle inside an open transaction this long. */
  readonly idleInTransactionMs: number;
}

export const POOL_TIMEOUTS: PoolTimeouts = {
  connectMs: 5000,
  statementMs: 10000,
  idleInTransactionMs: 10000,
};

export interface PortalPoolOptions {
  readonly connectionString: string;
  /** Receives one JSON line per pool failure, the same lines the shell reports. */
  readonly onError: (line: string) => void;
  readonly timeouts?: Partial<PoolTimeouts>;
}

/**
 * The one pool of both portal applications. Every wait on the database is
 * bounded, so a stalled database fails a sign-in instead of holding it open.
 *
 * `query_timeout` is not set: it is a client-side timer that rejects without
 * cancelling the statement, and the client it leaves behind fails on reuse
 * (observed on PostgreSQL). `statement_timeout` is the server's own, and
 * cancels the statement cleanly.
 *
 * A server that ends a session (an idle-in-transaction kill, a restart, a
 * terminated backend) makes the client emit `error`. An emitter with no
 * listener throws it, and an uncaught exception ends the process, which
 * signs everyone out because sessions are held in memory. pg-pool listens
 * for an idle client and removes that listener while the client is checked
 * out, so the pool's own `error` event does not cover a checked-out client:
 * each client gets its own listener as it connects.
 */
export function createPortalPool(options: PortalPoolOptions): pg.Pool {
  const timeouts = { ...POOL_TIMEOUTS, ...options.timeouts };
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: timeouts.connectMs,
    statement_timeout: timeouts.statementMs,
    idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
  });
  // An idle client that fails reaches both listeners with the same error.
  const reported = new WeakSet<object>();
  const report = (error: unknown): void => {
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    try {
      options.onError(portalErrorLine('pool', error));
    } catch {
      // Nowhere left to report to.
    }
  };
  pool.on('error', report);
  pool.on('connect', (client) => client.on('error', report));
  return pool;
}

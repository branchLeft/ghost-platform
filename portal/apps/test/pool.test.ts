import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testUrl } from '../../data/test/helpers.js';
import { portalErrorLine } from '../src/shell/errorLine.js';
import { createPortalPool, POOL_TIMEOUTS } from '../src/shell/pool.js';
import {
  connectTimeout,
  errorCode,
  exhaustedPool,
  GRACE_MS,
  idleClientKilled,
  idleInTransaction,
  SMALL,
  statementTimeout,
} from './poolScenarios.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(`${directory}${entry.name}/`)
      : entry.name.endsWith('.ts')
        ? [`${directory}${entry.name}`]
        : []
  );
}

describe('the portal pool bounds every wait on the database', () => {
  it('cancels a statement that runs past the limit, with SQLSTATE 57014', async () => {
    const { attempt } = await statementTimeout(createPortalPool);
    expect(attempt.settled).toBe(true);
    expect(errorCode(attempt.error)).toBe('57014');
    expect(attempt.elapsedMs).toBeLessThan(SMALL.statementMs + GRACE_MS);
  });

  it('gives up on a database that never answers the connection', async () => {
    const { attempt } = await connectTimeout(createPortalPool);
    expect(attempt.settled).toBe(true);
    expect(String((attempt.error as Error).message)).toMatch(/timeout/i);
    expect(attempt.elapsedMs).toBeLessThan(SMALL.connectMs + GRACE_MS);
  });

  it('gives up waiting when every client is checked out, and recovers when one is returned', async () => {
    const { attempt, usableAfterRelease } = await exhaustedPool(createPortalPool);
    expect(attempt.settled).toBe(true);
    expect(String((attempt.error as Error).message)).toMatch(/timeout/i);
    expect(attempt.elapsedMs).toBeLessThan(SMALL.connectMs + GRACE_MS);
    expect(usableAfterRelease).toBe(true);
  });
});

describe('a client the server ends does not take the process down', () => {
  it('logs a checked-out client killed for idling in a transaction (25P03), and survives', async () => {
    const outcome = await idleInTransaction(createPortalPool);
    expect(outcome.uncaught).toEqual([]);
    expect(outcome.nextStatementFailed).toBe(true);
    expect(outcome.freshClientWorks).toBe(true);
    expect(outcome.lines.map((line) => JSON.parse(line) as unknown)).toContainEqual({
      event: 'portal.error',
      step: 'pool',
      error: 'error',
      code: '25P03',
    });
  });

  it('logs an idle client whose connection is terminated (57P01) once, and drops it', async () => {
    const outcome = await idleClientKilled(createPortalPool);
    expect(outcome.uncaught).toEqual([]);
    expect(outcome.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'portal.error', step: 'pool', error: 'error', code: '57P01' },
    ]);
    expect(outcome.idleAfter).toBe(0);
    expect(outcome.poolStillWorks).toBe(true);
  });

  it('keeps going when the sink for the log line itself throws', async () => {
    const pool = createPortalPool({
      connectionString: testUrl('postgres'),
      onError: () => {
        throw new Error('stderr closed');
      },
    });
    pool.emit('error', new Error('x'));
    await pool.end();
  });
});

describe('the timeout values', () => {
  async function serverSettings(pool: pg.Pool): Promise<Record<string, unknown>> {
    const result = await pool.query(
      `select current_setting('statement_timeout') as statement,
              current_setting('idle_in_transaction_session_timeout') as idle`
    );
    return result.rows[0] as Record<string, unknown>;
  }

  it('default to 5000 connect, 10000 statement and 10000 idle-in-transaction', async () => {
    expect(POOL_TIMEOUTS).toEqual({
      connectMs: 5000,
      statementMs: 10000,
      idleInTransactionMs: 10000,
    });
    const pool = createPortalPool({
      connectionString: testUrl('postgres'),
      onError: () => undefined,
    });
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(5000);
      expect(await serverSettings(pool)).toEqual({ statement: '10s', idle: '10s' });
    } finally {
      await pool.end();
    }
  });

  it('are each replaced by an override', async () => {
    const pool = createPortalPool({
      connectionString: testUrl('postgres'),
      onError: () => undefined,
      timeouts: { connectMs: 1111, statementMs: 2222, idleInTransactionMs: 3333 },
    });
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(1111);
      expect(await serverSettings(pool)).toEqual({ statement: '2222ms', idle: '3333ms' });
    } finally {
      await pool.end();
    }
  });

  it('are set on a partial override without losing the other defaults', async () => {
    const pool = createPortalPool({
      connectionString: testUrl('postgres'),
      onError: () => undefined,
      timeouts: { statementMs: 2222 },
    });
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(5000);
      expect(await serverSettings(pool)).toEqual({ statement: '2222ms', idle: '10s' });
    } finally {
      await pool.end();
    }
  });
});

describe('the pool line', () => {
  it('carries the error name and the SQLSTATE, never the message', () => {
    const error = Object.assign(new Error('password authentication failed for user "secret"'), {
      code: '28P01',
    });
    const line = portalErrorLine('pool', error);
    expect(JSON.parse(line)).toEqual({
      event: 'portal.error',
      step: 'pool',
      error: 'Error',
      code: '28P01',
    });
    expect(line).not.toContain('secret');
  });

  it('omits a code that is not a SQLSTATE, and a code on any other step', () => {
    const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(JSON.parse(portalErrorLine('pool', refused))).toEqual({
      event: 'portal.error',
      step: 'pool',
      error: 'Error',
    });
    expect(JSON.parse(portalErrorLine('pool', 'text'))).toEqual({
      event: 'portal.error',
      step: 'pool',
      error: 'string',
    });
    const withState = Object.assign(new Error('x'), { code: '57014' });
    expect(JSON.parse(portalErrorLine('handler', withState))).toEqual({
      event: 'portal.error',
      step: 'handler',
      error: 'Error',
    });
  });
});

describe('both entry points build their pool here', () => {
  it('leaves no other `new pg.Pool` in the applications', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /new\s+pg\.Pool\b/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((file) => file.slice(SRC.length))).toEqual(['shell/pool.ts']);
  });

  it.each(['tenant/main.ts', 'console/main.ts'])('%s calls createPortalPool', (file) => {
    const source = readFileSync(`${SRC}${file}`, 'utf8');
    expect(source).toMatch(
      /createPortalPool\(\{ connectionString: config\.databaseUrl, onError: writeLine \}\)/
    );
    expect(source).not.toMatch(/from 'pg'/);
  });
});

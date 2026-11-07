import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { testUrl } from '../../data/test/helpers.js';
import type { PortalPoolOptions } from '../src/shell/pool.js';

export type CreatePool = (options: PortalPoolOptions) => pg.Pool;

/** How long past its own limit a scenario waits before it calls an operation hung. */
export const GRACE_MS = 1500;

export const SMALL = { connectMs: 300, statementMs: 300, idleInTransactionMs: 300 } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Attempt {
  /** False when the operation had not finished by the time the scenario gave up. */
  readonly settled: boolean;
  readonly elapsedMs: number;
  readonly error?: unknown;
}

async function attempt(operation: Promise<unknown>, limitMs: number): Promise<Attempt> {
  const started = Date.now();
  const done = operation.then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error })
  );
  const result = await Promise.race([done, sleep(limitMs).then(() => undefined)]);
  const elapsedMs = Date.now() - started;
  if (result === undefined) return { settled: false, elapsedMs };
  return result.failed
    ? { settled: true, elapsedMs, error: result.error }
    : { settled: true, elapsedMs };
}

export function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/**
 * Runs `body` with the test runner's own uncaught-exception handlers
 * set aside, and returns whatever the process would have died of. A runner
 * that was left to see it would fail the whole run, which is the point in
 * the real module and not in a deliberately broken copy.
 */
export async function catchingUncaught(body: () => Promise<void>): Promise<readonly unknown[]> {
  const saved = process.listeners('uncaughtException');
  const uncaught: unknown[] = [];
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error) => uncaught.push(error));
  try {
    await body();
  } finally {
    process.removeAllListeners('uncaughtException');
    for (const listener of saved) process.on('uncaughtException', listener);
  }
  return uncaught;
}

function lineCollector(): { lines: string[]; onError: (line: string) => void } {
  const lines: string[] = [];
  return { lines, onError: (line) => void lines.push(line) };
}

export interface StatementOutcome {
  readonly attempt: Attempt;
}

/** A statement that runs far past the limit is cancelled by the server. */
export async function statementTimeout(create: CreatePool): Promise<StatementOutcome> {
  const { onError } = lineCollector();
  const pool = create({
    connectionString: testUrl('postgres'),
    onError,
    timeouts: SMALL,
  });
  try {
    return {
      attempt: await attempt(pool.query('select pg_sleep(4)'), SMALL.statementMs + GRACE_MS),
    };
  } finally {
    await pool.end();
  }
}

/** A server that accepts the connection and never answers. */
async function silentServer(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface ConnectOutcome {
  readonly attempt: Attempt;
}

/** A database that never answers: the connection attempt gives up. */
export async function connectTimeout(create: CreatePool): Promise<ConnectOutcome> {
  const silent = await silentServer();
  const pool = create({
    connectionString: `postgres://nobody@127.0.0.1:${silent.port}/postgres`,
    onError: () => undefined,
    timeouts: SMALL,
  });
  try {
    return {
      attempt: await attempt(pool.query('select 1'), SMALL.connectMs + GRACE_MS),
    };
  } finally {
    // Closing the silent server's sockets also lets a connection that was
    // left waiting finish, so `end()` returns even for a broken pool.
    await silent.close();
    await pool.end();
  }
}

export interface ExhaustedOutcome {
  readonly attempt: Attempt;
  /** The one client was usable again once it was released. */
  readonly usableAfterRelease: boolean;
}

/** Every client is checked out: the next caller gives up instead of waiting for ever. */
export async function exhaustedPool(create: CreatePool): Promise<ExhaustedOutcome> {
  const pool = create({
    connectionString: testUrl('postgres'),
    onError: () => undefined,
    timeouts: SMALL,
  });
  pool.options.max = 1;
  const held = await pool.connect();
  try {
    // A client handed over late is given straight back, so a broken pool can still end.
    const waiting = await attempt(
      pool.connect().then((late) => late.release()),
      SMALL.connectMs + GRACE_MS
    );
    held.release();
    const usableAfterRelease = (await pool.query('select 1 as one')).rows[0]?.one === 1;
    return { attempt: waiting, usableAfterRelease };
  } finally {
    await pool.end();
  }
}

export interface IdleInTransactionOutcome {
  readonly lines: readonly string[];
  readonly uncaught: readonly unknown[];
  /** The killed client refuses its next statement. */
  readonly nextStatementFailed: boolean;
  /** A client that had not been idle past the limit is still fine. */
  readonly freshClientWorks: boolean;
}

/** A client left idle inside a transaction is ended by the server, and the process lives. */
export async function idleInTransaction(create: CreatePool): Promise<IdleInTransactionOutcome> {
  const { lines, onError } = lineCollector();
  let nextStatementFailed = false;
  let freshClientWorks = false;
  const uncaught = await catchingUncaught(async () => {
    const pool = create({
      connectionString: testUrl('postgres'),
      onError,
      timeouts: SMALL,
    });
    try {
      const client = await pool.connect();
      await client.query('begin');
      await sleep(SMALL.idleInTransactionMs + 700);
      try {
        await client.query('select 1');
      } catch {
        nextStatementFailed = true;
      }
      client.release(true);
      freshClientWorks = (await pool.query('select 1 as one')).rows[0]?.one === 1;
    } finally {
      await pool.end();
    }
    // An error that arrives after the body would still be uncaught.
    await sleep(200);
  });
  return { lines, uncaught, nextStatementFailed, freshClientWorks };
}

export interface IdleClientOutcome {
  readonly lines: readonly string[];
  readonly uncaught: readonly unknown[];
  readonly idleAfter: number;
  readonly poolStillWorks: boolean;
}

/** An idle client whose backend is terminated is logged once and dropped. */
export async function idleClientKilled(create: CreatePool): Promise<IdleClientOutcome> {
  const { lines, onError } = lineCollector();
  let idleAfter = -1;
  let poolStillWorks = false;
  const uncaught = await catchingUncaught(async () => {
    const pool = create({ connectionString: testUrl('postgres'), onError });
    const admin = new pg.Client({ connectionString: testUrl('postgres') });
    try {
      await admin.connect();
      const client = await pool.connect();
      const pid = (await client.query('select pg_backend_pid() as pid')).rows[0]?.pid as number;
      client.release();
      await admin.query('select pg_terminate_backend($1)', [pid]);
      await sleep(500);
      idleAfter = pool.idleCount;
      poolStillWorks = (await pool.query('select 1 as one')).rows[0]?.one === 1;
    } finally {
      await admin.end();
      await pool.end();
    }
    await sleep(200);
  });
  return { lines, uncaught, idleAfter, poolStillWorks };
}

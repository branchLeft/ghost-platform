import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainServer } from '../src/drain.js';
import { createLogger } from '../src/log.js';
import { openQueue, type Queue } from '../src/queue.js';
import { createStats } from '../src/stats.js';
import { send } from './helpers/harness.js';

const TOKEN = 'DRAIN_TOKEN_PLACEHOLDER_0123456789ABCDEF';

let dir: string;
let queue: Queue;
let server: Server;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'swd-'));
  queue = openQueue(dir);
  server = createDrainServer(
    { queue, stats: createStats(), log: createLogger(() => undefined), token: TOKEN },
    { headersTimeoutMs: 5000, requestTimeoutMs: 10000, keepAliveTimeoutMs: 2000 }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  for (let i = 1; i <= 3; i += 1) {
    queue.append({ outcomeId: `OUTCOME_ID_PLACEHOLDER_${i}`, class: 'abuse', at: 1000 + i });
  }
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  queue.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('drain authentication', () => {
  it.each([
    ['no header', {}],
    ['wrong token', { authorization: 'Bearer WRONG_TOKEN_PLACEHOLDER' }],
    ['same length, wrong token', { authorization: `Bearer ${TOKEN.slice(0, -1)}X` }],
    ['no Bearer prefix', { authorization: TOKEN }],
    ['wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['empty token', { authorization: 'Bearer ' }],
  ])('refuses %s on every route', async (_name, headers) => {
    expect((await send(port, 'GET', '/drain', undefined, headers)).status).toBe(401);
    expect((await send(port, 'POST', '/drain/ack', '{"through":3}', headers)).status).toBe(401);
    expect((await send(port, 'GET', '/stats', undefined, headers)).status).toBe(401);
    expect((await send(port, 'GET', '/nowhere', undefined, headers)).status).toBe(401);
    expect(queue.stats().records).toBe(3);
  });
});

describe('drain routes', () => {
  it('returns queued records oldest first', async () => {
    const reply = await send(port, 'GET', '/drain', undefined, auth);
    expect(reply.status).toBe(200);
    const records = (JSON.parse(reply.body) as { records: { seq: number }[] }).records;
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('honours after and limit', async () => {
    const reply = await send(port, 'GET', '/drain?after=1&limit=1', undefined, auth);
    const records = (JSON.parse(reply.body) as { records: { seq: number }[] }).records;
    expect(records.map((r) => r.seq)).toEqual([2]);
  });

  it.each(['limit=0', 'limit=501', 'limit=abc', 'after=-1', 'after=1.5'])(
    'refuses parameter %s',
    async (query) => {
      expect((await send(port, 'GET', `/drain?${query}`, undefined, auth)).status).toBe(400);
    }
  );

  it('releases records only when the collector acknowledges them', async () => {
    await send(port, 'GET', '/drain', undefined, auth);
    expect(queue.stats().records).toBe(3);
    const ack = await send(port, 'POST', '/drain/ack', '{"through":2}', auth);
    expect(ack.status).toBe(200);
    expect(queue.read(0, 10).map((r) => r.seq)).toEqual([3]);
  });

  it('refuses an acknowledgement beyond the queue, or malformed', async () => {
    expect((await send(port, 'POST', '/drain/ack', '{"through":99}', auth)).status).toBe(400);
    expect((await send(port, 'POST', '/drain/ack', '{"through":"2"}', auth)).status).toBe(400);
    expect((await send(port, 'POST', '/drain/ack', 'nope', auth)).status).toBe(400);
    expect(queue.stats().records).toBe(3);
  });

  it('refuses an oversized acknowledgement body', async () => {
    const reply = await send(port, 'POST', '/drain/ack', 'x'.repeat(2000), auth);
    expect(reply.status).toBe(413);
  });

  it('never reuses a sequence number after the queue empties', async () => {
    await send(port, 'POST', '/drain/ack', '{"through":3}', auth);
    expect(queue.append({ outcomeId: 'OUTCOME_ID_PLACEHOLDER_4', class: 'abuse', at: 1 })).toBe(4);
  });

  it('reports counters and queue state', async () => {
    const reply = await send(port, 'GET', '/stats', undefined, auth);
    expect(reply.status).toBe(200);
    expect((JSON.parse(reply.body) as { queue: { records: number } }).queue.records).toBe(3);
  });

  it('answers 404 to an unknown route once authenticated', async () => {
    expect((await send(port, 'GET', '/nowhere', undefined, auth)).status).toBe(404);
  });
});

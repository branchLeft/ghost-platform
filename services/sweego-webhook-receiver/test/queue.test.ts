import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openQueue, QueueFullError, QUEUE_MAX_BYTES } from '../src/queue.js';
import { openReplayStore, REPLAY_MAX_ENTRIES } from '../src/replay.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swq-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (n: number) => ({ outcomeId: `OUTCOME_ID_PLACEHOLDER_${n}`, class: 'abuse', at: n });

describe('queue', () => {
  it('has a hard cap of 5 MiB', () => {
    expect(QUEUE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('refuses at the cap and never evicts', () => {
    const q = openQueue(dir, 200);
    let n = 0;
    expect(() => {
      // Bounded, so a missing cap fails the test instead of filling the disk.
      for (let i = 0; i < 50; i += 1) {
        n += 1;
        q.append(rec(n));
      }
    }).toThrow(QueueFullError);
    const held = q.read(0, 100);
    expect(held.length).toBe(n - 1);
    expect(held[0]?.seq).toBe(1);
    expect(q.stats().bytes).toBeLessThanOrEqual(200);
    q.close();
  });

  it('survives a restart with its records and sequence', () => {
    const q = openQueue(dir);
    q.append(rec(1));
    q.append(rec(2));
    q.close();
    const again = openQueue(dir);
    expect(again.read(0, 10).map((r) => r.seq)).toEqual([1, 2]);
    expect(again.append(rec(3))).toBe(3);
    again.close();
  });

  it('keeps its sequence across a restart after everything is acknowledged', () => {
    const q = openQueue(dir);
    q.append(rec(1));
    q.ack(1);
    q.close();
    const again = openQueue(dir);
    expect(again.stats().records).toBe(0);
    expect(again.append(rec(2))).toBe(2);
    again.close();
  });

  it('drops a half-written last line left by a crash', () => {
    const q = openQueue(dir);
    q.append(rec(1));
    q.close();
    appendFileSync(join(dir, 'queue.ndjson'), '{"seq":2,"outcomeId":"HALF');
    const again = openQueue(dir);
    expect(again.read(0, 10).map((r) => r.seq)).toEqual([1]);
    expect(again.append(rec(2))).toBe(2);
    again.close();
    expect(
      readFileSync(join(dir, 'queue.ndjson'), 'utf8').split('\n').filter(Boolean)
    ).toHaveLength(2);
  });

  it('refuses to start on a corrupt record', () => {
    appendFileSync(join(dir, 'queue.ndjson'), 'not json\n');
    expect(() => openQueue(dir)).toThrow();
  });

  it('replaces a torn temporary meta file left by a crash and leaves no temporary behind', () => {
    const q = openQueue(dir);
    q.append(rec(1));
    q.close();
    writeFileSync(join(dir, 'queue.meta.tmp'), '{"acked":');
    const again = openQueue(dir);
    again.ack(1);
    again.close();
    expect(existsSync(join(dir, 'queue.meta.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'queue.meta'), 'utf8'))).toEqual({ acked: 1 });
    expect(openQueue(dir).stats().nextSeq).toBe(2);
  });

  it('never leaves queue.meta half-written when the new copy cannot be written', () => {
    const q = openQueue(dir);
    q.append(rec(1));
    q.append(rec(2));
    q.ack(1);
    // a directory where the temporary file belongs makes the next write fail
    rmSync(join(dir, 'queue.meta.tmp'), { force: true });
    mkdirSync(join(dir, 'queue.meta.tmp'));
    expect(() => q.ack(2)).toThrow();
    expect(JSON.parse(readFileSync(join(dir, 'queue.meta'), 'utf8'))).toEqual({ acked: 1 });
    q.close();
  });

  it('keeps room in the replay set for every record the queue can hold', () => {
    const smallest = JSON.stringify({ seq: 1, outcomeId: 'a', class: 'a', at: 1_700_000_000 });
    const mostRecords = Math.floor(QUEUE_MAX_BYTES / (Buffer.byteLength(smallest) + 1));
    // each accepted complaint adds two keys, so the queue cap must bind first
    expect(REPLAY_MAX_ENTRIES).toBeGreaterThanOrEqual(2 * mostRecords);
  });
});

describe('replay store', () => {
  it('refuses new entries at its cap rather than forgetting old ones', () => {
    const now = () => 1_000_000;
    const store = openReplayStore(dir, now, { maxEntries: 2 });
    store.add(['id:A', 'ev:A']);
    expect(() => store.add(['id:B'])).toThrow();
    expect(store.has('id:A')).toBe(true);
    store.close();
  });

  it('forgets an entry only after its time is up', () => {
    let ms = 1_000_000;
    const store = openReplayStore(dir, () => ms, { ttlSeconds: 10 });
    store.add(['id:A']);
    ms += 9_000;
    expect(store.has('id:A')).toBe(true);
    ms += 2_000;
    expect(store.has('id:A')).toBe(false);
    store.close();
  });
});

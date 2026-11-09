import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hashOf, makeClock, newTempDir, quietLogger } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { VerdictQueue } = require('../../verdict-host/queue.js');

let directory;
const opened = [];

function makeQueue(options = {}) {
  directory ??= newTempDir();
  const clock = options.clock ?? makeClock();
  const { logger, lines } = quietLogger();
  const queue = new VerdictQueue({
    journalFile: path.join(directory, 'queue.journal'),
    now: clock.now,
    logger,
    ...options,
  }).open();
  opened.push(queue);
  return { queue, clock, lines };
}

afterEach(() => {
  while (opened.length > 0) opened.pop().close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('asking', () => {
  it('queues a new hash once and reports it queued again without a second entry', () => {
    const { queue } = makeQueue();
    expect(queue.ask(hashOf(1))).toEqual({ status: 'queued' });
    expect(queue.ask(hashOf(1))).toEqual({ status: 'queued' });
    expect(queue.counts().queued).toBe(1);
  });

  it('refuses a new hash once the queue is full, and still takes a known one', () => {
    const { queue } = makeQueue({ maxQueued: 2 });
    queue.ask(hashOf(1));
    queue.ask(hashOf(2));
    expect(queue.ask(hashOf(3))).toEqual({ status: 'full' });
    expect(queue.ask(hashOf(2))).toEqual({ status: 'queued' });
  });

  it('answers a recent verdict at once and forgets it after its lifetime', () => {
    const { queue, clock } = makeQueue({ verdictTtlMs: 1000 });
    queue.ask(hashOf(1));
    const { batch } = queue.lease();
    queue.settle(batch, new Map([[hashOf(1), { classification: 'csam', matchType: 'exact' }]]));
    const again = queue.ask(hashOf(1));
    expect(again.status).toBe('verdict');
    expect(again.verdict).toMatchObject({ classification: 'csam', matchType: 'exact' });
    clock.advance(1000);
    expect(queue.ask(hashOf(1))).toEqual({ status: 'queued' });
  });

  it('reports an error, not a queued hash, when the journal cannot be written', () => {
    const { queue, lines } = makeQueue();
    queue.close();
    expect(queue.ask(hashOf(1))).toEqual({ status: 'error' });
    expect(lines.join('\n')).toContain('VERDICT_HOST_JOURNAL_WRITE_FAILED');
    expect(queue.counts().queued).toBe(0);
  });
});

describe('leasing and settling', () => {
  it('hands over at most 500 hashes in a batch, oldest first, each once', () => {
    const { queue } = makeQueue();
    for (let n = 0; n < 600; n += 1)
      queue.ask(Buffer.from(`${n}`.padStart(32, '0')).toString('base64'));
    const first = queue.lease();
    expect(first.hashes).toHaveLength(500);
    const second = queue.lease();
    expect(second.hashes).toHaveLength(100);
    expect(new Set([...first.hashes, ...second.hashes]).size).toBe(600);
    expect(queue.lease()).toBeNull();
  });

  it('names a batch with at least 16 characters from the contract alphabet', () => {
    const { queue } = makeQueue();
    queue.ask(hashOf(1));
    expect(queue.lease().batch).toMatch(/^[A-Za-z0-9._-]{16,128}$/);
  });

  it('returns a hash with no definitive answer to the queue, paced', () => {
    const { queue, clock } = makeQueue({ reofferDelayMs: 5000 });
    queue.ask(hashOf(1));
    queue.ask(hashOf(2));
    const { batch } = queue.lease();
    expect(queue.settle(batch, new Map([[hashOf(1), { classification: 'no-known-match' }]]))).toBe(
      true
    );
    expect(queue.lease()).toBeNull();
    clock.advance(5000);
    expect(queue.lease().hashes).toEqual([hashOf(2)]);
  });

  it('refuses to settle a batch it does not hold, and a batch settled twice', () => {
    const { queue } = makeQueue();
    queue.ask(hashOf(1));
    const { batch } = queue.lease();
    expect(queue.settle('not-a-batch-name-at-all', new Map())).toBe(false);
    expect(queue.settle(batch, new Map())).toBe(true);
    expect(queue.settle(batch, new Map())).toBe(false);
  });

  it('ends a lease that was not settled in time and offers its hashes again after a pause', () => {
    const { queue, clock } = makeQueue({ leaseMs: 1000, reofferDelayMs: 500 });
    queue.ask(hashOf(1));
    const { batch } = queue.lease();
    expect(queue.batchHashes(batch)).toEqual([hashOf(1)]);
    clock.advance(1000);
    expect(queue.batchHashes(batch)).toBeNull();
    expect(queue.settle(batch, new Map([[hashOf(1), { classification: 'csam' }]]))).toBe(false);
    expect(queue.lease()).toBeNull();
    clock.advance(500);
    expect(queue.lease().hashes).toEqual([hashOf(1)]);
  });

  it('emits a verdict event for a settled hash, carrying the hash it settled', () => {
    const { queue } = makeQueue();
    const events = [];
    queue.on('verdict', (event) => events.push(event));
    queue.ask(hashOf(1));
    const { batch } = queue.lease();
    queue.settle(batch, new Map([[hashOf(1), { classification: 'test' }]]));
    expect(events).toEqual([
      { hash: hashOf(1), verdict: { classification: 'test', at: expect.any(Number) } },
    ]);
  });

  it('ignores an answer for a hash that left the queue', () => {
    const { queue } = makeQueue();
    queue.ask(hashOf(1));
    const { batch } = queue.lease();
    expect(queue.settle(batch, new Map([[hashOf(9), { classification: 'csam' }]]))).toBe(true);
    expect(queue.ask(hashOf(9)).status).toBe('queued');
  });

  it('keeps going when the verdict cannot be written, and says so', () => {
    const { queue, lines } = makeQueue();
    queue.ask(hashOf(1));
    const { batch } = queue.lease();
    queue.close();
    expect(queue.settle(batch, new Map([[hashOf(1), { classification: 'csam' }]]))).toBe(true);
    expect(lines.join('\n')).toContain('VERDICT_HOST_JOURNAL_WRITE_FAILED');
  });
});

describe('the age of the oldest unverdicted hash', () => {
  it('is zero when nothing waits, grows while nothing drains, and returns to zero when drained', () => {
    const { queue, clock } = makeQueue();
    expect(queue.oldestAgeSeconds()).toBe(0);
    queue.ask(hashOf(1));
    clock.advance(10_000);
    queue.ask(hashOf(2));
    expect(queue.oldestAgeSeconds()).toBeCloseTo(10, 0);
    clock.advance(20_000);
    expect(queue.oldestAgeSeconds()).toBeCloseTo(30, 0);
    const { batch } = queue.lease();
    // Handed over is not answered: the age keeps growing while leased.
    clock.advance(5000);
    expect(queue.oldestAgeSeconds()).toBeCloseTo(35, 0);
    queue.settle(
      batch,
      new Map([
        [hashOf(1), { classification: 'no-known-match' }],
        [hashOf(2), { classification: 'no-known-match' }],
      ])
    );
    expect(queue.oldestAgeSeconds()).toBe(0);
  });
});

describe('a restart', () => {
  it('keeps every hash that was waiting, with its original age', () => {
    const clock = makeClock();
    const first = makeQueue({ clock });
    first.queue.ask(hashOf(1));
    first.queue.ask(hashOf(2));
    const { batch } = first.queue.lease();
    first.queue.settle(batch, new Map([[hashOf(2), { classification: 'csam' }]]));
    clock.advance(60_000);
    first.queue.close();

    const second = makeQueue({ clock });
    expect(second.queue.counts()).toEqual({ queued: 1, leased: 0, verdicts: 1 });
    expect(second.queue.oldestAgeSeconds()).toBeCloseTo(60, 0);
    expect(second.queue.ask(hashOf(2)).status).toBe('verdict');
    expect(second.queue.lease().hashes).toEqual([hashOf(1)]);
  });

  it('forgets an expired verdict when it replays', () => {
    const clock = makeClock();
    const first = makeQueue({ clock, verdictTtlMs: 1000 });
    first.queue.ask(hashOf(1));
    first.queue.settle(
      first.queue.lease().batch,
      new Map([[hashOf(1), { classification: 'test' }]])
    );
    first.queue.close();
    clock.advance(2000);
    const second = makeQueue({ clock, verdictTtlMs: 1000 });
    expect(second.queue.counts().verdicts).toBe(0);
  });

  it('drops a half-written last record and skips a damaged one, and says how many', () => {
    directory = newTempDir();
    const file = path.join(directory, 'queue.journal');
    const good = JSON.stringify({ t: 'q', h: hashOf(1), at: 1000 });
    fs.writeFileSync(file, `${good}\nnot json at all\n{"t":"q","h":"${hashOf(2)}","at":2000`, {
      mode: 0o600,
    });
    const { queue, lines } = makeQueue();
    expect(queue.counts().queued).toBe(1);
    expect(lines.join('\n')).toContain('VERDICT_HOST_JOURNAL_SKIPPED_LINES count=1');
  });

  it('refuses a journal that is a symbolic link', () => {
    directory = newTempDir();
    fs.writeFileSync(path.join(directory, 'real'), '');
    fs.symlinkSync(path.join(directory, 'real'), path.join(directory, 'queue.journal'));
    expect(() => makeQueue()).toThrow();
  });

  it('rewrites the journal small when it grows past the compaction point, losing nothing', () => {
    const clock = makeClock();
    const first = makeQueue({ clock, compactAfter: 5 });
    for (let n = 1; n <= 12; n += 1) first.queue.ask(hashOf(n));
    const { batch } = first.queue.lease();
    first.queue.settle(
      batch,
      new Map(
        first.queue
          .batchHashes(batch)
          .slice(0, 6)
          .map((h) => [h, { classification: 'test' }])
      )
    );
    first.queue.close();
    const lines = fs.readFileSync(path.join(directory, 'queue.journal'), 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(12 + 6);
    const second = makeQueue({ clock });
    expect(second.queue.counts()).toEqual({ queued: 6, leased: 0, verdicts: 6 });
  });

  it('is private to its owner', () => {
    const { queue } = makeQueue();
    queue.ask(hashOf(1));
    expect(fs.statSync(path.join(directory, 'queue.journal')).mode & 0o077).toBe(0);
  });
});

describe('construction', () => {
  it('needs an absolute journal path and positive limits', () => {
    expect(() => new VerdictQueue({ journalFile: 'relative' })).toThrow('absolute');
    expect(() => new VerdictQueue({ journalFile: '/tmp/x', leaseMs: 0 })).toThrow('leaseMs');
  });
});

describe('housekeeping', () => {
  it('sweep ends expired leases and forgets old verdicts', () => {
    const { queue, clock } = makeQueue({ leaseMs: 1000, verdictTtlMs: 1000, reofferDelayMs: 1 });
    queue.ask(hashOf(1));
    queue.ask(hashOf(2));
    const { batch } = queue.lease();
    queue.settle(batch, new Map([[hashOf(2), { classification: 'test' }]]));
    queue.ask(hashOf(3));
    queue.lease();
    clock.advance(1500);
    queue.sweep();
    expect(queue.counts()).toEqual({ queued: 2, leased: 0, verdicts: 0 });
  });
});

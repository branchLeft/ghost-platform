import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDroppedOutcomes, type DroppedOutcomes } from '../../src/droppedOutcomes.js';
import { createLogger } from '../../src/log.js';

/**
 * The queue of reports waiting for the spool must outlive the process: a
 * restart must not lose a dropped recipient that is not yet reported.
 */
describe('the dropped-outcome queue kept across a restart', () => {
  const target = { id: 'tenant-a', baseUrl: 'http://127.0.0.1:1', route: 'sweego' as const };
  let dir: string;
  let statePath: string;
  let logLines: string[];
  let sent: string[][];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dropped-outcomes-state-'));
    statePath = join(dir, 'dropped-outcomes.json');
    logLines = [];
    sent = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reporter(
    options: { now?: () => number; giveUpMs?: number; reject?: boolean; path?: string } = {}
  ): DroppedOutcomes {
    return createDroppedOutcomes({
      client: {
        reportOutcomes: async (_target, outcomes) => {
          if (options.reject) {
            throw new Error('spool not reachable');
          }
          sent.push(outcomes.map((o) => o.id));
          return { recorded: outcomes.map((o) => o.id), alreadyHandled: [], unknown: [] };
        },
      },
      log: createLogger((line) => logLines.push(line)),
      statePath: options.path ?? statePath,
      ...(options.now ? { now: options.now } : {}),
      ...(options.giveUpMs ? { giveUpMs: options.giveUpMs } : {}),
    });
  }

  it('reloads a report that was acked but not yet reported, and sends it after the restart', async () => {
    const before = reporter();
    before.dropped('tenant-a', 'm-1', 1);
    before.acked({ acked: ['m-1'], alreadyHandled: [], unknown: [] });

    const after = reporter();
    expect(after.pending).toBe(1);
    await after.flush(target);
    expect(sent).toEqual([['m-1']]);
    expect(after.pending).toBe(0);
  });

  it('keeps a report the spool never answered: it is still queued and still on disk', async () => {
    const failing = reporter({ reject: true });
    failing.dropped('tenant-a', 'm-1', 1);
    failing.acked({ acked: ['m-1'], alreadyHandled: [], unknown: [] });
    await failing.flush(target);
    expect(failing.pending).toBe(1);
    expect(readFileSync(statePath, 'utf8')).toContain('m-1');
  });

  it('a report given up on stays given up after a restart', async () => {
    let clock = 0;
    const now = () => clock;
    const first = reporter({ now, giveUpMs: 100 });
    first.dropped('tenant-a', 'm-1', 1);
    first.acked({ acked: ['m-1'], alreadyHandled: [], unknown: [] });
    clock = 100;
    await first.flush(target);
    expect(first.pending).toBe(0);
    expect(reporter({ now }).pending).toBe(0);
  });

  it('quarantines a corrupt queue file, keeps its bytes, and starts empty with the ack path working', async () => {
    writeFileSync(statePath, 'not json {');
    const next = reporter();
    expect(next.pending).toBe(0);
    const quarantined = readdirSync(dir).filter((name) =>
      name.startsWith('dropped-outcomes.json.corrupt-')
    );
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, quarantined[0] as string), 'utf8')).toBe('not json {');
    next.dropped('tenant-a', 'm-2', 1);
    next.acked({ acked: ['m-2'], alreadyHandled: [], unknown: [] });
    await next.flush(target);
    expect(sent).toEqual([['m-2']]);
    expect(logLines.some((line) => line.includes('dropped_outcome_state_quarantined'))).toBe(true);
  });

  it('keeps the queue in memory and counts the failure when the state cannot be written', () => {
    writeFileSync(join(dir, 'blocker'), 'a file where a directory is needed');
    const unwritable = reporter({ path: join(dir, 'blocker', 'dropped-outcomes.json') });
    unwritable.dropped('tenant-a', 'm-3', 1);
    expect(unwritable.pending).toBe(1);
    expect(unwritable.stateErrors).toBeGreaterThan(0);
    expect(logLines.some((line) => line.includes('dropped_outcome_state_failed'))).toBe(true);
  });
});

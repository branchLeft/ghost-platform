import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trace: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      (handle as unknown as Record<string, unknown>)['write'] = async (...a: unknown[]) => {
        trace.push('write');
        return write(...a);
      };
      handle.sync = async () => {
        trace.push('sync');
        return sync();
      };
      handle.close = async () => {
        trace.push('close');
        return close();
      };
      return handle;
    },
  };
});

const { FileStateStore } = await import('../../src/index.js');

let dir = '';
afterEach(async () => {
  trace.length = 0;
  await rm(dir, { recursive: true, force: true });
});

describe('FileStateStore durability', () => {
  it('syncs the record to disk before append resolves, then syncs the new directory entry', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pc-fsync-'));
    const store = new FileStateStore(join(dir, 'state.jsonl'));
    await store.append({
      at: 'A',
      approvalId: 'B',
      event: 'run-halted',
    });
    const writeAt = trace.indexOf('write');
    const firstSync = trace.indexOf('sync');
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(firstSync).toBeGreaterThan(writeAt);
    expect(trace.filter((t) => t === 'sync')).toHaveLength(2);

    trace.length = 0;
    await store.append({ at: 'A', approvalId: 'B', event: 'run-halted' });
    expect(trace.filter((t) => t === 'sync')).toHaveLength(1);
    expect(trace.indexOf('sync')).toBeGreaterThan(trace.indexOf('write'));
  });
});

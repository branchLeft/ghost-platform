import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCleanupScheduler } from '../../src/cleanup.js';
import { createTestLogger, type TestLogger } from '../helpers/testLogger.js';
import type { ShimStore } from '../../src/store.js';

function fakeStoreWithCleanup(cleanupCompletedBatches: (olderThan: number) => number): ShimStore {
  return {
    cleanupCompletedBatches,
  } as unknown as ShimStore;
}

describe('startCleanupScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs cleanup once immediately, before any interval has elapsed — matching the deleted worker\'s own "first tick always cleans up" behaviour', () => {
    const cleanupCompletedBatches = vi.fn().mockReturnValue(0);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const scheduler = startCleanupScheduler(store, createTestLogger().logger, { now: () => 1000 });
    expect(cleanupCompletedBatches).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('calls cleanupCompletedBatches with now - retentionSeconds', () => {
    const cleanupCompletedBatches = vi.fn().mockReturnValue(0);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const scheduler = startCleanupScheduler(store, createTestLogger().logger, {
      now: () => 1_000_000,
      retentionSeconds: 500,
    });
    expect(cleanupCompletedBatches).toHaveBeenCalledWith(999_500);
    scheduler.stop();
  });

  it('runs again on every subsequent interval', () => {
    const cleanupCompletedBatches = vi.fn().mockReturnValue(0);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const scheduler = startCleanupScheduler(store, createTestLogger().logger, {
      now: () => 0,
      intervalMs: 1000,
    });
    expect(cleanupCompletedBatches).toHaveBeenCalledTimes(1); // the immediate run

    vi.advanceTimersByTime(1000);
    expect(cleanupCompletedBatches).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2000);
    expect(cleanupCompletedBatches).toHaveBeenCalledTimes(4);

    scheduler.stop();
  });

  it('logs queue_cleanup only when something was actually deleted', () => {
    const cleanupCompletedBatches = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(3);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const testLogger: TestLogger = createTestLogger();
    const scheduler = startCleanupScheduler(store, testLogger.logger, {
      now: () => 0,
      intervalMs: 1000,
    });
    expect(testLogger.lines.some((l) => l.event === 'queue_cleanup')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(testLogger.lines.filter((l) => l.event === 'queue_cleanup')).toHaveLength(1);
    expect(testLogger.lines.find((l) => l.event === 'queue_cleanup')?.fields).toEqual({
      deletedBatches: 3,
    });

    scheduler.stop();
  });

  it('stop() halts the interval — no further calls after stopping', () => {
    const cleanupCompletedBatches = vi.fn().mockReturnValue(0);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const scheduler = startCleanupScheduler(store, createTestLogger().logger, {
      now: () => 0,
      intervalMs: 1000,
    });
    const callsBeforeStop = cleanupCompletedBatches.mock.calls.length;
    scheduler.stop();

    vi.advanceTimersByTime(10_000);
    expect(cleanupCompletedBatches).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it('defaults `now` to the real wall clock when not overridden', () => {
    vi.setSystemTime(5_000_000_000);
    const cleanupCompletedBatches = vi.fn().mockReturnValue(0);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const scheduler = startCleanupScheduler(store, createTestLogger().logger, {
      retentionSeconds: 100,
    });
    expect(cleanupCompletedBatches).toHaveBeenCalledWith(5_000_000 - 100);
    scheduler.stop();
  });

  it('defaults to the documented 30-day retention and 1-hour interval when not overridden', () => {
    const cleanupCompletedBatches = vi.fn().mockReturnValue(0);
    const store = fakeStoreWithCleanup(cleanupCompletedBatches);
    const scheduler = startCleanupScheduler(store, createTestLogger().logger, {
      now: () => 10_000_000,
    });
    expect(cleanupCompletedBatches).toHaveBeenCalledWith(10_000_000 - 30 * 24 * 3600);

    cleanupCompletedBatches.mockClear();
    vi.advanceTimersByTime(3600 * 1000 - 1);
    expect(cleanupCompletedBatches).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cleanupCompletedBatches).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});

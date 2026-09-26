import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThrottle } from '../../src/throttle.js';

describe('createThrottle', () => {
  it('starts with exactly one grace token, not a full bucket', () => {
    let now = 0;
    const throttle = createThrottle({ messagesPerHour: 3600, now: () => now });
    expect(throttle.tryTake()).toBe(true);
    expect(throttle.tryTake()).toBe(false);
  });

  it('refills at messagesPerHour tokens per hour', () => {
    let now = 0;
    const throttle = createThrottle({ messagesPerHour: 3600, now: () => now });
    expect(throttle.tryTake()).toBe(true);
    expect(throttle.tryTake()).toBe(false);
    now += 1; // one second at 3600/hour = one token/second
    expect(throttle.tryTake()).toBe(true);
  });

  it('never exceeds the configured rate as a cap', () => {
    let now = 0;
    const throttle = createThrottle({ messagesPerHour: 10, now: () => now });
    throttle.tryTake();
    now += 100 * 3600; // way more than enough time to overflow if uncapped
    let taken = 0;
    while (throttle.tryTake()) {
      taken += 1;
    }
    expect(taken).toBe(10);
  });

  it('currentRate() reports the configured rate', () => {
    const throttle = createThrottle({ messagesPerHour: 42 });
    expect(throttle.currentRate()).toBe(42);
  });

  it('waitForToken() resolves immediately when a token is already available', async () => {
    const throttle = createThrottle({ messagesPerHour: 3600 });
    await expect(throttle.waitForToken()).resolves.toBeUndefined();
  });

  it('waitForToken() waits for a token to accrue rather than rejecting', async () => {
    let now = 0;
    const throttle = createThrottle({ messagesPerHour: 3600 * 4, now: () => now });
    throttle.tryTake(); // consume the grace token
    const pending = throttle.waitForToken();
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    now += 1; // accrues a token at this rate
    await pending;
    expect(resolved).toBe(true);
  });

  it('waitForToken() rejects immediately when the signal is already aborted', async () => {
    const throttle = createThrottle({ messagesPerHour: 1 });
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(throttle.waitForToken(controller.signal)).rejects.toThrow('already cancelled');
  });

  it('waitForToken() rejects when the signal aborts before a token is available', async () => {
    const throttle = createThrottle({ messagesPerHour: 1 });
    throttle.tryTake();
    const controller = new AbortController();
    const pending = throttle.waitForToken(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  describe('reload()', () => {
    let dir: string;
    let configPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'collector-throttle-'));
      configPath = join(dir, 'throttle.json');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('is a no-op with no configPath', () => {
      const throttle = createThrottle({ messagesPerHour: 5 });
      throttle.reload();
      expect(throttle.currentRate()).toBe(5);
    });

    it('adopts a new rate written to configPath', () => {
      writeFileSync(configPath, JSON.stringify({ messagesPerHour: 5 }));
      const throttle = createThrottle({ messagesPerHour: 5, configPath });
      throttle.reload();
      expect(throttle.currentRate()).toBe(5);

      writeFileSync(configPath, JSON.stringify({ messagesPerHour: 999 }));
      throttle.reload();
      expect(throttle.currentRate()).toBe(999);
    });

    it('keeps the previous rate when the file is missing', () => {
      const throttle = createThrottle({ messagesPerHour: 7, configPath });
      throttle.reload();
      expect(throttle.currentRate()).toBe(7);
    });

    it('keeps the previous rate when the file is malformed JSON', () => {
      writeFileSync(configPath, '{not json');
      const throttle = createThrottle({ messagesPerHour: 7, configPath });
      throttle.reload();
      expect(throttle.currentRate()).toBe(7);
    });

    it('ignores an unchanged mtime rather than re-parsing', () => {
      writeFileSync(configPath, JSON.stringify({ messagesPerHour: 11 }));
      const throttle = createThrottle({ messagesPerHour: 7, configPath });
      throttle.reload();
      expect(throttle.currentRate()).toBe(11);
      // Same mtime, different content -- reload() must not re-read.
      const before = throttle.currentRate();
      throttle.reload();
      expect(throttle.currentRate()).toBe(before);
    });
  });
});

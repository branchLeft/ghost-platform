import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThrottle } from '../../src/throttle.js';

describe('createThrottle — token bucket', () => {
  it('starts empty — a fresh throttle grants nothing at time zero', () => {
    const throttle = createThrottle({ envMessagesPerHour: 10, now: () => 0 });
    expect(throttle.tryTake()).toBe(false);
  });

  it('grants at most messagesPerHour sends across a simulated hour', () => {
    let now = 0;
    const throttle = createThrottle({ envMessagesPerHour: 10, now: () => now });

    let granted = 0;
    // One attempted send per minute for a full hour plus one — 61 attempts
    // against a 10/hour cap.
    for (let minute = 0; minute <= 60; minute += 1) {
      now = minute * 60;
      if (throttle.tryTake()) {
        granted += 1;
      }
    }

    expect(granted).toBeLessThanOrEqual(10);
    expect(granted).toBeGreaterThan(0);
  });

  it('accrues capacity linearly and caps at messagesPerHour', () => {
    let now = 0;
    const throttle = createThrottle({ envMessagesPerHour: 60, now: () => now });
    // 60/hour == 1/minute; after 5 minutes exactly 5 tokens are available,
    // in one burst, none more until further time passes.
    now = 5 * 60;
    let granted = 0;
    for (let i = 0; i < 10; i += 1) {
      if (throttle.tryTake()) {
        granted += 1;
      }
    }
    expect(granted).toBe(5);
  });

  it('defaults to 50/hour when no env value is given', () => {
    const throttle = createThrottle({ envMessagesPerHour: 0 });
    expect(throttle.currentRate()).toBe(50);
  });

  it('uses envMessagesPerHour when positive', () => {
    const throttle = createThrottle({ envMessagesPerHour: 200 });
    expect(throttle.currentRate()).toBe(200);
  });
});

describe('createThrottle — file reload', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-throttle-test-'));
    configPath = join(dir, 'throttle.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no effect until reload() is called', () => {
    writeFileSync(configPath, JSON.stringify({ messagesPerHour: 5 }));
    const throttle = createThrottle({ configPath, envMessagesPerHour: 50 });
    expect(throttle.currentRate()).toBe(50);
    throttle.reload();
    expect(throttle.currentRate()).toBe(5);
  });

  it('changes the effective rate on a later reload after the file changes — no new throttle instance needed', async () => {
    writeFileSync(configPath, JSON.stringify({ messagesPerHour: 5 }));
    const throttle = createThrottle({ configPath, envMessagesPerHour: 50 });
    throttle.reload();
    expect(throttle.currentRate()).toBe(5);

    // mtime resolution is coarse on some filesystems — make the second
    // write land in a distinguishably later tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(configPath, JSON.stringify({ messagesPerHour: 25 }));
    throttle.reload();
    expect(throttle.currentRate()).toBe(25);
  });

  it('a reload with no file change is a no-op', () => {
    writeFileSync(configPath, JSON.stringify({ messagesPerHour: 5 }));
    const throttle = createThrottle({ configPath, envMessagesPerHour: 50 });
    throttle.reload();
    throttle.reload();
    expect(throttle.currentRate()).toBe(5);
  });

  it('keeps the previously effective rate when the file is missing', () => {
    const throttle = createThrottle({
      configPath: join(dir, 'does-not-exist.json'),
      envMessagesPerHour: 50,
    });
    throttle.reload();
    expect(throttle.currentRate()).toBe(50);
  });

  it('keeps the previously effective rate when the file has malformed JSON', () => {
    writeFileSync(configPath, 'not json');
    const throttle = createThrottle({ configPath, envMessagesPerHour: 50 });
    throttle.reload();
    expect(throttle.currentRate()).toBe(50);
  });

  it('ignores a non-positive or non-numeric messagesPerHour in the file', () => {
    writeFileSync(configPath, JSON.stringify({ messagesPerHour: -5 }));
    const throttle = createThrottle({ configPath, envMessagesPerHour: 50 });
    throttle.reload();
    expect(throttle.currentRate()).toBe(50);
  });

  it('has no configPath at all — reload() is a permanent no-op', () => {
    const throttle = createThrottle({ envMessagesPerHour: 50 });
    throttle.reload();
    expect(throttle.currentRate()).toBe(50);
  });

  it('logs a throttle_reload event only when the effective rate actually changes', () => {
    writeFileSync(configPath, JSON.stringify({ messagesPerHour: 5 }));
    const lines: unknown[] = [];
    const throttle = createThrottle({
      configPath,
      envMessagesPerHour: 50,
      log: {
        log: () => {},
        info: (event, fields) => lines.push({ event, fields }),
        warn: () => {},
        error: () => {},
      },
    });
    throttle.reload();
    throttle.reload();
    expect(lines).toHaveLength(1);
  });
});

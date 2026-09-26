import { describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../../src/heartbeat.js';
import { createLogger } from '../../src/log.js';

function silentLogger() {
  return createLogger(() => {});
}

describe('startHeartbeat', () => {
  it('pings immediately on start, with no drain activity required', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const heartbeat = startHeartbeat({
      url: 'https://heartbeat.example/ping',
      intervalMs: 50,
      log: silentLogger(),
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith('https://heartbeat.example/ping', { method: 'GET' });
    heartbeat.stop();
  });

  it('keeps ticking on its own timer while idle, and stop() ends it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const heartbeat = startHeartbeat({
      url: 'https://heartbeat.example/ping',
      intervalMs: 20,
      log: silentLogger(),
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3));
    heartbeat.stop();
    const countAtStop = fetchImpl.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchImpl.mock.calls.length).toBe(countAtStop);
  });

  it('logs a failed ping but keeps the timer running rather than crashing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const heartbeat = startHeartbeat({
      url: 'https://heartbeat.example/ping',
      intervalMs: 20,
      log,
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    heartbeat.stop();
  });

  it('logs a rejected (non-ok) response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const heartbeat = startHeartbeat({
      url: 'https://heartbeat.example/ping',
      intervalMs: 500,
      log,
      fetchImpl,
    });
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThanOrEqual(1));
    expect(warnings[0]).toMatchObject({ event: 'heartbeat_rejected' });
    heartbeat.stop();
  });
});

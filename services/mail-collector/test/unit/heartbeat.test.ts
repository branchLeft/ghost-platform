import { describe, expect, it, vi } from 'vitest';
import { createDeadMansSwitch } from '../../src/heartbeat.js';
import { createLogger } from '../../src/log.js';

function silentLogger() {
  return createLogger(() => {});
}

describe('createDeadMansSwitch', () => {
  it('pings only in response to onCycleComplete() -- never on its own before being called', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('onCycleComplete() pings once per call, with no timer keeping it going on its own', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
    });
    switch_.onCycleComplete();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith('https://heartbeat.example/ping', { method: 'GET' });

    // No second call arrives on its own -- proves there is no timer behind
    // this, only the caller's own onCycleComplete() calls.
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    switch_.onCycleComplete();
    switch_.onCycleComplete();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });

  it('onCycleComplete() never returns a promise the caller could await -- the ping is fire-and-forget', () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
    });
    const result = switch_.onCycleComplete();
    expect(result).toBeUndefined();
  });

  it('logs a failed ping but does not throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const switch_ = createDeadMansSwitch({ url: 'https://heartbeat.example/ping', log, fetchImpl });
    switch_.onCycleComplete();
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThanOrEqual(1));
    expect(warnings[0]).toMatchObject({ event: 'heartbeat_failed' });
  });

  it('logs a rejected (non-ok) response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const switch_ = createDeadMansSwitch({ url: 'https://heartbeat.example/ping', log, fetchImpl });
    switch_.onCycleComplete();
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThanOrEqual(1));
    expect(warnings[0]).toMatchObject({ event: 'heartbeat_rejected' });
  });

  it('shouldPing() returning false suppresses the fetch for that call, and logs it', () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log,
      fetchImpl,
      shouldPing: () => false,
    });
    switch_.onCycleComplete();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnings[0]).toMatchObject({ event: 'heartbeat_suppressed' });
  });

  it('pinging resumes the moment shouldPing() recovers, on the very next completed cycle', async () => {
    let healthy = false;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
      shouldPing: () => healthy,
    });
    switch_.onCycleComplete();
    expect(fetchImpl).not.toHaveBeenCalled();
    healthy = true;
    switch_.onCycleComplete();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  it('with no shouldPing supplied, pings unconditionally on every call (the plain default)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
    });
    switch_.onCycleComplete();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createDeadMansSwitch } from '../../src/heartbeat.js';
import { createLogger } from '../../src/log.js';

function silentLogger() {
  return createLogger(() => {});
}

const oneTarget = () => ['tenant-a'];

describe('createDeadMansSwitch', () => {
  it('pings only in response to onCycleComplete() -- never on its own before being called', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
      getExpectedTargetIds: oneTarget,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('onCycleComplete() pings once per call for a single-target collector, with no timer keeping it going on its own', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
      getExpectedTargetIds: oneTarget,
    });
    switch_.onCycleComplete('tenant-a');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith('https://heartbeat.example/ping', { method: 'GET' });

    // No second call arrives on its own -- proves there is no timer behind
    // this, only the caller's own onCycleComplete() calls.
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    switch_.onCycleComplete('tenant-a');
    switch_.onCycleComplete('tenant-a');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });

  it('onCycleComplete() never returns a promise the caller could await -- the ping is fire-and-forget', () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
      getExpectedTargetIds: oneTarget,
    });
    const result = switch_.onCycleComplete('tenant-a');
    expect(result).toBeUndefined();
  });

  it('logs a failed ping but does not throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log,
      fetchImpl,
      getExpectedTargetIds: oneTarget,
    });
    switch_.onCycleComplete('tenant-a');
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThanOrEqual(1));
    expect(warnings[0]).toMatchObject({ event: 'heartbeat_failed' });
  });

  it('logs a rejected (non-ok) response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const warnings: unknown[] = [];
    const log = createLogger(() => {});
    log.warn = (event, fields) => warnings.push({ event, fields });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log,
      fetchImpl,
      getExpectedTargetIds: oneTarget,
    });
    switch_.onCycleComplete('tenant-a');
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
      getExpectedTargetIds: oneTarget,
    });
    switch_.onCycleComplete('tenant-a');
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
      getExpectedTargetIds: oneTarget,
    });
    switch_.onCycleComplete('tenant-a');
    expect(fetchImpl).not.toHaveBeenCalled();
    healthy = true;
    switch_.onCycleComplete('tenant-a');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  it('with no shouldPing supplied, pings unconditionally on every call (the plain default)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
      getExpectedTargetIds: oneTarget,
    });
    switch_.onCycleComplete('tenant-a');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });

  it('with the expected target list empty, withholds the ping rather than treating it as vacuously satisfied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const switch_ = createDeadMansSwitch({
      url: 'https://heartbeat.example/ping',
      log: silentLogger(),
      fetchImpl,
      getExpectedTargetIds: () => [],
    });
    switch_.onCycleComplete('tenant-a');
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('per-host gating -- owner ruling on branchLeft/workspace#1265 (PR #275, option b)', () => {
    it('pings only once EVERY expected target has reported since the last ping, not on the first one alone', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const switch_ = createDeadMansSwitch({
        url: 'https://heartbeat.example/ping',
        log: silentLogger(),
        fetchImpl,
        getExpectedTargetIds: () => ['tenant-a', 'tenant-b'],
      });
      switch_.onCycleComplete('tenant-a');
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchImpl).not.toHaveBeenCalled(); // tenant-b hasn't reported yet

      switch_.onCycleComplete('tenant-b');
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    });

    it('a target that never reports again (wedged, or permanently failing its own cycle) silences every subsequent ping', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const switch_ = createDeadMansSwitch({
        url: 'https://heartbeat.example/ping',
        log: silentLogger(),
        fetchImpl,
        getExpectedTargetIds: () => ['tenant-a', 'tenant-b'],
      });
      switch_.onCycleComplete('tenant-a');
      switch_.onCycleComplete('tenant-b');
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      // tenant-a keeps completing cycles fine; tenant-b never reports again.
      for (let i = 0; i < 5; i += 1) {
        switch_.onCycleComplete('tenant-a');
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no further ping fired
    });

    it('recovery: once the silent target reports again, pinging resumes on that very cycle', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const switch_ = createDeadMansSwitch({
        url: 'https://heartbeat.example/ping',
        log: silentLogger(),
        fetchImpl,
        getExpectedTargetIds: () => ['tenant-a', 'tenant-b'],
      });
      switch_.onCycleComplete('tenant-a');
      switch_.onCycleComplete('tenant-b');
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      switch_.onCycleComplete('tenant-a'); // tenant-b silent for a while
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      switch_.onCycleComplete('tenant-b'); // recovers
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    });

    it('all targets completing an EMPTY cycle still pings -- zero mail across the board is not a failure', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const switch_ = createDeadMansSwitch({
        url: 'https://heartbeat.example/ping',
        log: silentLogger(),
        fetchImpl,
        getExpectedTargetIds: () => ['tenant-a', 'tenant-b', 'tenant-c'],
      });
      switch_.onCycleComplete('tenant-a');
      switch_.onCycleComplete('tenant-b');
      switch_.onCycleComplete('tenant-c');
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    });

    it('a target removed from the expected set is no longer required for the ping', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      let expected = ['tenant-a', 'tenant-b'];
      const switch_ = createDeadMansSwitch({
        url: 'https://heartbeat.example/ping',
        log: silentLogger(),
        fetchImpl,
        getExpectedTargetIds: () => expected,
      });
      switch_.onCycleComplete('tenant-a'); // tenant-b never reports -- e.g. its descriptor is gone
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchImpl).not.toHaveBeenCalled();

      expected = ['tenant-a']; // descriptor no longer names tenant-b
      switch_.onCycleComplete('tenant-a');
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    });
  });
});

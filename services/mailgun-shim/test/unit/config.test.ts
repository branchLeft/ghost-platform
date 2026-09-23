import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = { SHIM_DRAIN_TOKEN: 'the-drain-token' };

describe('loadConfig', () => {
  it('throws when SHIM_DB_PATH is unset and the ephemeral escape hatch is not opted into', () => {
    expect(() => loadConfig({ ...baseEnv })).toThrow(/SHIM_DB_PATH/);
  });

  it('throws when SHIM_DB_PATH is explicitly ":memory:" without the escape hatch', () => {
    expect(() => loadConfig({ ...baseEnv, SHIM_DB_PATH: ':memory:' })).toThrow(/SHIM_DB_PATH/);
  });

  it('allows an ephemeral store when SHIM_ALLOW_EPHEMERAL_DB=true', () => {
    const config = loadConfig({ ...baseEnv, SHIM_ALLOW_EPHEMERAL_DB: 'true' });
    expect(config.dbPath).toBe(':memory:');
  });

  it('uses a real SHIM_DB_PATH without needing the escape hatch', () => {
    const config = loadConfig({ ...baseEnv, SHIM_DB_PATH: '/data/shim.sqlite' });
    expect(config.dbPath).toBe('/data/shim.sqlite');
  });

  it('requires SHIM_DRAIN_TOKEN', () => {
    expect(() => loadConfig({ SHIM_ALLOW_EPHEMERAL_DB: 'true' })).toThrow(/SHIM_DRAIN_TOKEN/);
  });

  it('defaults port, messagesPerHour and every drain option', () => {
    const config = loadConfig({ ...baseEnv, SHIM_ALLOW_EPHEMERAL_DB: 'true' });
    expect(config.port).toBe(8080);
    expect(config.messagesPerHour).toBe(50);
    expect(config.throttlePath).toBeUndefined();
    expect(config.drainToken).toBe('the-drain-token');
    expect(config.drainHoldMs).toBe(30_000);
    expect(config.drainLeaseSeconds).toBe(30);
    expect(config.drainBatchLimit).toBe(25);
    expect(config.drainPollIntervalMs).toBe(250);
  });

  it('reads PORT, SHIM_MESSAGES_PER_HOUR and every SHIM_DRAIN_* override', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      PORT: '9090',
      SHIM_MESSAGES_PER_HOUR: '120',
      SHIM_DRAIN_HOLD_MS: '5000',
      SHIM_DRAIN_LEASE_SECONDS: '60',
      SHIM_DRAIN_BATCH_LIMIT: '10',
      SHIM_DRAIN_POLL_INTERVAL_MS: '100',
    });
    expect(config.port).toBe(9090);
    expect(config.messagesPerHour).toBe(120);
    expect(config.drainHoldMs).toBe(5000);
    expect(config.drainLeaseSeconds).toBe(60);
    expect(config.drainBatchLimit).toBe(10);
    expect(config.drainPollIntervalMs).toBe(100);
  });

  it('falls back to 50 for a non-positive SHIM_MESSAGES_PER_HOUR', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_MESSAGES_PER_HOUR: '-1',
    });
    expect(config.messagesPerHour).toBe(50);
  });

  it('falls back to the default for a non-positive SHIM_DRAIN_HOLD_MS', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_DRAIN_HOLD_MS: '0',
    });
    expect(config.drainHoldMs).toBe(30_000);
  });

  it('passes through SHIM_THROTTLE_PATH', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_THROTTLE_PATH: '/etc/shim/throttle.json',
    });
    expect(config.throttlePath).toBe('/etc/shim/throttle.json');
  });
});

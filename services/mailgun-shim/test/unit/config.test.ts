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
    expect(config.maxRecipientsPerMessage).toBe(50);
  });

  it('reads SHIM_MAX_RECIPIENTS_PER_MESSAGE', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_MAX_RECIPIENTS_PER_MESSAGE: '5',
    });
    expect(config.maxRecipientsPerMessage).toBe(5);
  });

  it('falls back to 50 for a non-positive SHIM_MAX_RECIPIENTS_PER_MESSAGE', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_MAX_RECIPIENTS_PER_MESSAGE: '0',
    });
    expect(config.maxRecipientsPerMessage).toBe(50);
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

  it("defaults smtpFrontDoor to port 25, matching LLD-6's diagram", () => {
    const config = loadConfig({ ...baseEnv, SHIM_ALLOW_EPHEMERAL_DB: 'true' });
    expect(config.smtpFrontDoor.port).toBe(25);
    expect(config.smtpFrontDoor.host).toBe('0.0.0.0');
    expect(config.smtpFrontDoor.maxMessageBytes).toBe(2 * 1024 * 1024);
    expect(config.smtpFrontDoor.maxUnauthenticatedConnections).toBe(100);
    expect(config.smtpFrontDoor.authDeadlineMs).toBe(5000);
    expect(config.smtpFrontDoor.maxConcurrentDataPhases).toBe(20);
    expect(config.smtpFrontDoor.maxConcurrentDataPhasesPerSubmitter).toBe(5);
    expect(config.smtpFrontDoor.submitterMessagesPerMinute).toBe(120);
    expect(config.smtpFrontDoor.allowedSourceCidrs).toEqual([
      '127.0.0.1/32',
      '::1/128',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      'fc00::/7',
    ]);
  });

  it('reads SMTP_LISTEN_PORT/HOST, SMTP_MAX_MESSAGE_BYTES, SMTP_MAX_UNAUTHENTICATED_CONNECTIONS, SMTP_AUTH_DEADLINE_MS, SMTP_MAX_CONCURRENT_DATA_PHASES(_PER_SUBMITTER), SMTP_ALLOWED_SOURCE_CIDRS and SMTP_SUBMITTER_MESSAGES_PER_MINUTE', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SMTP_LISTEN_PORT: '2525',
      SMTP_LISTEN_HOST: '127.0.0.1',
      SMTP_MAX_MESSAGE_BYTES: '1024',
      SMTP_MAX_UNAUTHENTICATED_CONNECTIONS: '7',
      SMTP_AUTH_DEADLINE_MS: '2000',
      SMTP_MAX_CONCURRENT_DATA_PHASES: '4',
      SMTP_MAX_CONCURRENT_DATA_PHASES_PER_SUBMITTER: '2',
      SMTP_ALLOWED_SOURCE_CIDRS: '10.0.0.0/8, 172.16.0.0/12',
      SMTP_SUBMITTER_MESSAGES_PER_MINUTE: '5',
    });
    expect(config.smtpFrontDoor.port).toBe(2525);
    expect(config.smtpFrontDoor.host).toBe('127.0.0.1');
    expect(config.smtpFrontDoor.maxMessageBytes).toBe(1024);
    expect(config.smtpFrontDoor.maxUnauthenticatedConnections).toBe(7);
    expect(config.smtpFrontDoor.authDeadlineMs).toBe(2000);
    expect(config.smtpFrontDoor.maxConcurrentDataPhases).toBe(4);
    expect(config.smtpFrontDoor.maxConcurrentDataPhasesPerSubmitter).toBe(2);
    expect(config.smtpFrontDoor.allowedSourceCidrs).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
    expect(config.smtpFrontDoor.submitterMessagesPerMinute).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const BASE_ENV = {
  COLLECTOR_DESCRIPTOR_DIR: '/tmp/descriptors',
  COLLECTOR_DRAIN_TOKEN: 'token',
  COLLECTOR_SMTP_HOST: 'mx1.example.internal',
  COLLECTOR_SMTP_USER: 'collector',
  COLLECTOR_SMTP_PASS: 'secret',
  COLLECTOR_HEARTBEAT_URL: 'https://heartbeat.example/ping',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.port).toBe(8080);
    expect(config.descriptorRefreshMs).toBe(5000);
    expect(config.descriptorMaxStalenessMs).toBe(60000);
    expect(config.shimPort).toBe(8080);
    expect(config.drainTimeoutMs).toBe(40000);
    expect(config.messagesPerHour).toBe(50);
    expect(config.dedupeTtlMs).toBe(3600000);
    expect(config.smtp).toEqual({
      host: 'mx1.example.internal',
      port: 587,
      secure: false,
      user: 'collector',
      pass: 'secret',
    });
    expect(config.heartbeatIntervalMs).toBe(60000);
  });

  it.each([
    'COLLECTOR_DESCRIPTOR_DIR',
    'COLLECTOR_DRAIN_TOKEN',
    'COLLECTOR_SMTP_HOST',
    'COLLECTOR_SMTP_USER',
    'COLLECTOR_SMTP_PASS',
    'COLLECTOR_HEARTBEAT_URL',
  ])('throws when %s is missing', (name) => {
    const env = { ...BASE_ENV, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it('honours overrides', () => {
    const config = loadConfig({
      ...BASE_ENV,
      PORT: '9090',
      COLLECTOR_MESSAGES_PER_HOUR: '200',
      COLLECTOR_SHIM_PORT: '9999',
      COLLECTOR_SMTP_SECURE: 'true',
      COLLECTOR_SMTP_PORT: '465',
    });
    expect(config.port).toBe(9090);
    expect(config.messagesPerHour).toBe(200);
    expect(config.shimPort).toBe(9999);
    expect(config.smtp.secure).toBe(true);
    expect(config.smtp.port).toBe(465);
  });

  it('ignores a non-positive override and falls back to the default', () => {
    const config = loadConfig({ ...BASE_ENV, COLLECTOR_MESSAGES_PER_HOUR: '-5' });
    expect(config.messagesPerHour).toBe(50);
  });
});

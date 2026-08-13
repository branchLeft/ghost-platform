import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = { SMTP_HOST: 'smtp.example.com' };

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

  it('requires SMTP_HOST', () => {
    expect(() => loadConfig({ SHIM_ALLOW_EPHEMERAL_DB: 'true' })).toThrow(/SMTP_HOST/);
  });

  it('defaults port, SMTP port/secure and messagesPerHour', () => {
    const config = loadConfig({ ...baseEnv, SHIM_ALLOW_EPHEMERAL_DB: 'true' });
    expect(config.port).toBe(8080);
    expect(config.smtp.port).toBe(587);
    expect(config.smtp.secure).toBe(false);
    expect(config.smtp.auth).toBeUndefined();
    expect(config.messagesPerHour).toBe(50);
    expect(config.throttlePath).toBeUndefined();
  });

  it('reads PORT, SMTP_PORT, SMTP_SECURE, SMTP_USER/PASS and SHIM_MESSAGES_PER_HOUR', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      PORT: '9090',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'true',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SHIM_MESSAGES_PER_HOUR: '120',
    });
    expect(config.port).toBe(9090);
    expect(config.smtp.port).toBe(2525);
    expect(config.smtp.secure).toBe(true);
    expect(config.smtp.auth).toEqual({ user: 'user', pass: 'pass' });
    expect(config.messagesPerHour).toBe(120);
  });

  it('falls back to 50 for a non-positive SHIM_MESSAGES_PER_HOUR', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_MESSAGES_PER_HOUR: '-1',
    });
    expect(config.messagesPerHour).toBe(50);
  });

  it('passes through SHIM_THROTTLE_PATH', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SHIM_THROTTLE_PATH: '/etc/shim/throttle.json',
    });
    expect(config.throttlePath).toBe('/etc/shim/throttle.json');
  });

  it('leaves smtp.auth undefined when only one of SMTP_USER/SMTP_PASS is set', () => {
    const config = loadConfig({
      ...baseEnv,
      SHIM_ALLOW_EPHEMERAL_DB: 'true',
      SMTP_USER: 'user-only',
    });
    expect(config.smtp.auth).toBeUndefined();
  });
});

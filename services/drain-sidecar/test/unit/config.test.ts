import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('refuses to start without DRAIN_FLAG_PATH', () => {
    expect(() => loadConfig({})).toThrow(/DRAIN_FLAG_PATH/);
  });

  it('applies defaults for everything else', () => {
    const config = loadConfig({ DRAIN_FLAG_PATH: '/var/run/branchleft/drain' });
    expect(config.port).toBe(8080);
    expect(config.ghostHealthUrl).toBe('http://127.0.0.1:2368/');
    expect(config.ghostProbeTimeoutMs).toBe(2000);
  });

  it('honours overrides', () => {
    const config = loadConfig({
      DRAIN_FLAG_PATH: '/var/run/branchleft/drain',
      PORT: '9090',
      GHOST_HEALTH_URL: 'http://127.0.0.1:1234/',
      GHOST_PROBE_TIMEOUT_MS: '500',
    });
    expect(config.port).toBe(9090);
    expect(config.ghostHealthUrl).toBe('http://127.0.0.1:1234/');
    expect(config.ghostProbeTimeoutMs).toBe(500);
  });

  it('falls back on a non-numeric PORT rather than propagating NaN', () => {
    const config = loadConfig({
      DRAIN_FLAG_PATH: '/var/run/branchleft/drain',
      PORT: 'not-a-number',
    });
    expect(config.port).toBe(8080);
  });
});

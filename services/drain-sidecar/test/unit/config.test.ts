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
    expect(config.socketPath).toBeNull();
  });

  it('takes a unix socket path from SOCKET_PATH, and treats blank as unset', () => {
    const env = { DRAIN_FLAG_PATH: '/f' };
    expect(loadConfig({ ...env, SOCKET_PATH: '/run/sidecar/health.sock' }).socketPath).toBe(
      '/run/sidecar/health.sock'
    );
    expect(loadConfig({ ...env, SOCKET_PATH: '  ' }).socketPath).toBeNull();
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

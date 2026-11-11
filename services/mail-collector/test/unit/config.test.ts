import { describe, expect, it } from 'vitest';
import { loadConfig, sweegoUsable } from '../../src/config.js';

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
    expect(config.loginMessagesPerHour).toBe(3600);
    expect(config.bulkRampPath).toBeUndefined();
    expect(config.dedupeTtlMs).toBe(3600000);
    expect(config.dedupeStatePath).toBeUndefined();
    expect(config.bulkDeferralStatePath).toBeUndefined();
    expect(config.smtp).toEqual({
      host: 'mx1.example.internal',
      port: 587,
      secure: false,
      user: 'collector',
      pass: 'secret',
    });
    expect(config.shimScheme).toBe('http');
    expect(config.heartbeatFailureThreshold).toBe(5);
    expect(config.outcomes).toBeUndefined();
  });

  describe('bulkDeferralStatePath', () => {
    it('sits beside the dedupe state file when only that is set', () => {
      expect(
        loadConfig({
          ...BASE_ENV,
          COLLECTOR_DEDUPE_STATE_PATH: '/var/lib/collector/submitted.json',
        }).bulkDeferralStatePath
      ).toBe('/var/lib/collector/bulk-deferral.json');
    });

    it('is the explicit path when one is set', () => {
      expect(
        loadConfig({
          ...BASE_ENV,
          COLLECTOR_DEDUPE_STATE_PATH: '/var/lib/collector/submitted.json',
          COLLECTOR_BULK_DEFERRAL_STATE_PATH: '/var/lib/other/deferral.json',
        }).bulkDeferralStatePath
      ).toBe('/var/lib/other/deferral.json');
    });

    it('is unset when neither is set: the hold is then memory-only', () => {
      expect(loadConfig(BASE_ENV).bulkDeferralStatePath).toBeUndefined();
    });
  });

  describe('outcomes', () => {
    it('turns on only when both the return path and the notification directory are set', () => {
      expect(
        loadConfig({
          ...BASE_ENV,
          COLLECTOR_OUTCOMES_RETURN_PATH: 'outcomes@collector.example',
          COLLECTOR_OUTCOMES_DSN_DIR: '/var/dsn',
        }).outcomes
      ).toEqual({ returnPath: 'outcomes@collector.example', dsnDir: '/var/dsn', pollMs: 30000 });
    });

    it.each([
      ['COLLECTOR_OUTCOMES_RETURN_PATH', 'outcomes@collector.example'],
      ['COLLECTOR_OUTCOMES_DSN_DIR', '/var/dsn'],
    ])('refuses %s without its partner', (name, value) => {
      expect(() => loadConfig({ ...BASE_ENV, [name]: value })).toThrow(/set together/);
    });
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

  it('accepts an explicit https shim scheme -- the real mx1 topology, per the PR body runbook', () => {
    const config = loadConfig({ ...BASE_ENV, COLLECTOR_SHIM_SCHEME: 'https' });
    expect(config.shimScheme).toBe('https');
  });

  it('rejects a shim scheme that is neither http nor https', () => {
    expect(() => loadConfig({ ...BASE_ENV, COLLECTOR_SHIM_SCHEME: 'ftp' })).toThrow(
      /COLLECTOR_SHIM_SCHEME must be "http" or "https"/
    );
  });

  it('honours an overridden heartbeat failure threshold', () => {
    const config = loadConfig({ ...BASE_ENV, COLLECTOR_HEARTBEAT_FAILURE_THRESHOLD: '10' });
    expect(config.heartbeatFailureThreshold).toBe(10);
  });

  describe('the Sweego relay', () => {
    const SWEEGO_ENV = {
      ...BASE_ENV,
      COLLECTOR_SWEEGO_SMTP_HOST: 'SWEEGO_RELAY_HOST',
      COLLECTOR_SWEEGO_SMTP_USER: 'SWEEGO_RELAY_USER',
      COLLECTOR_SWEEGO_SMTP_PASS_FILE: '/etc/collector/sweego-credential',
      COLLECTOR_SWEEGO_MESSAGES_PER_HOUR: '120',
    };

    it('is absent, with its pin settings at their defaults, unless the host is set', () => {
      const config = loadConfig(BASE_ENV);
      expect(config.sweego).toBeUndefined();
      expect(config.pinStateDir).toBeUndefined();
      expect(config.stateWitnessDir).toBeUndefined();
      expect(config.pinTtlMs).toBe(35 * 24 * 60 * 60 * 1000);
    });

    it('carries the state witness directory when it is set', () => {
      expect(
        loadConfig({ ...BASE_ENV, COLLECTOR_STATE_WITNESS_DIR: '/var/witness' }).stateWitnessDir
      ).toBe('/var/witness');
    });

    it('carries the credential file path and its own rate, with documented defaults', () => {
      expect(loadConfig(SWEEGO_ENV).sweego).toEqual({
        host: 'SWEEGO_RELAY_HOST',
        port: 587,
        secure: false,
        user: 'SWEEGO_RELAY_USER',
        passFile: '/etc/collector/sweego-credential',
        messagesPerHour: 120,
        throttleConfigPath: undefined,
        timeoutMs: 20000,
        accountCap: undefined,
        usageStatePath: undefined,
      });
    });

    it('carries the account-wide cap and the counter file, with no default for either', () => {
      const sweego = loadConfig({
        ...SWEEGO_ENV,
        COLLECTOR_SWEEGO_ACCOUNT_CAP: '5000',
        COLLECTOR_SWEEGO_USAGE_STATE_PATH: '/var/lib/collector/sweego-usage.json',
      }).sweego;
      expect(sweego?.accountCap).toBe(5000);
      expect(sweego?.usageStatePath).toBe('/var/lib/collector/sweego-usage.json');
      const bare = loadConfig(SWEEGO_ENV).sweego;
      expect(bare?.accountCap).toBeUndefined();
      expect(bare?.usageStatePath).toBeUndefined();
    });

    it.each([['0'], ['-3'], ['1.5'], ['plenty'], ['Infinity']])(
      'refuses %s as the account cap: there is no unlimited',
      (value) => {
        expect(() => loadConfig({ ...SWEEGO_ENV, COLLECTOR_SWEEGO_ACCOUNT_CAP: value })).toThrow(
          /COLLECTOR_SWEEGO_ACCOUNT_CAP/
        );
      }
    );

    it('refuses the cap and the counter file without the host, rather than ignoring them', () => {
      expect(() => loadConfig({ ...BASE_ENV, COLLECTOR_SWEEGO_ACCOUNT_CAP: '5000' })).toThrow(
        /COLLECTOR_SWEEGO_SMTP_HOST/
      );
      expect(() =>
        loadConfig({ ...BASE_ENV, COLLECTOR_SWEEGO_USAGE_STATE_PATH: '/var/lib/x.json' })
      ).toThrow(/COLLECTOR_SWEEGO_SMTP_HOST/);
    });

    it('is usable only with the relay, the cap and the counter file all set', () => {
      const full = {
        ...SWEEGO_ENV,
        COLLECTOR_SWEEGO_ACCOUNT_CAP: '5000',
        COLLECTOR_SWEEGO_USAGE_STATE_PATH: '/var/lib/collector/sweego-usage.json',
      };
      expect(sweegoUsable(loadConfig(full).sweego)).toBe(true);
      expect(sweegoUsable(loadConfig(SWEEGO_ENV).sweego)).toBe(false);
      expect(
        sweegoUsable(loadConfig({ ...full, COLLECTOR_SWEEGO_ACCOUNT_CAP: undefined }).sweego)
      ).toBe(false);
      expect(
        sweegoUsable(loadConfig({ ...full, COLLECTOR_SWEEGO_USAGE_STATE_PATH: undefined }).sweego)
      ).toBe(false);
      expect(sweegoUsable(loadConfig(BASE_ENV).sweego)).toBe(false);
    });

    it.each([
      'COLLECTOR_SWEEGO_SMTP_USER',
      'COLLECTOR_SWEEGO_SMTP_PASS_FILE',
      'COLLECTOR_SWEEGO_MESSAGES_PER_HOUR',
    ])('throws when the host is set but %s is missing', (name) => {
      expect(() => loadConfig({ ...SWEEGO_ENV, [name]: undefined })).toThrow(new RegExp(name));
    });

    it.each([['0'], ['-3'], ['plenty']])(
      'refuses %s as the Sweego rate: the plan sets it, so there is no fallback',
      (value) => {
        expect(() =>
          loadConfig({ ...SWEEGO_ENV, COLLECTOR_SWEEGO_MESSAGES_PER_HOUR: value })
        ).toThrow(/COLLECTOR_SWEEGO_MESSAGES_PER_HOUR/);
      }
    );

    it('refuses a Sweego setting without the host, rather than ignoring it', () => {
      expect(() =>
        loadConfig({ ...BASE_ENV, COLLECTOR_SWEEGO_SMTP_PASS_FILE: '/etc/collector/credential' })
      ).toThrow(/COLLECTOR_SWEEGO_SMTP_HOST/);
    });

    it('refuses the credential as a value', () => {
      expect(() => loadConfig({ ...SWEEGO_ENV, COLLECTOR_SWEEGO_SMTP_PASS: 'a-value' })).toThrow(
        /read from a file/
      );
    });
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const ENV = {
  COLLECTOR_DESCRIPTOR_DIR: '/tmp/descriptors',
  COLLECTOR_DRAIN_TOKEN: 'token',
  COLLECTOR_SMTP_HOST: 'mx1.example.internal',
  COLLECTOR_SMTP_USER: 'collector',
  COLLECTOR_SMTP_PASS: 'secret',
  COLLECTOR_HEARTBEAT_URL: 'https://heartbeat.example/ping',
  COLLECTOR_SWEEGO_SMTP_HOST: 'SWEEGO_RELAY_HOST',
  COLLECTOR_SWEEGO_SMTP_USER: 'SWEEGO_RELAY_USER',
  COLLECTOR_SWEEGO_SMTP_PASS_FILE: '/etc/collector/sweego-credential',
  COLLECTOR_SWEEGO_MESSAGES_PER_HOUR: '120',
};

const COMPLAINTS = {
  COLLECTOR_COMPLAINTS_URL: 'http://RECEIVER_PRIVATE_ADDRESS:9000/',
  COLLECTOR_COMPLAINTS_TOKEN_FILE: '/etc/collector/receiver-token',
  COLLECTOR_SENT_JOURNAL_PATH: '/var/lib/collector/sent.ndjson',
};

describe('the Sweego complaint path in loadConfig', () => {
  it('is absent unless configured, and then the collector is exactly as before', () => {
    expect(loadConfig(ENV).complaints).toBeUndefined();
  });

  it('carries paths and documented defaults, with the token as a file path only', () => {
    expect(loadConfig({ ...ENV, ...COMPLAINTS }).complaints).toEqual({
      receiverUrl: 'http://RECEIVER_PRIVATE_ADDRESS:9000',
      tokenFile: '/etc/collector/receiver-token',
      sentJournalPath: '/var/lib/collector/sent.ndjson',
      sentJournalTtlMs: 35 * 24 * 60 * 60 * 1000,
      outcomeHeader: 'x-branchleft-outcome',
      pollMs: 30_000,
      retryBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      timeoutMs: 10_000,
      perTenantPerHour: 50,
      giveUpMs: 24 * 60 * 60 * 1000,
    });
  });

  it('honours overrides', () => {
    const config = loadConfig({
      ...ENV,
      ...COMPLAINTS,
      COLLECTOR_COMPLAINTS_PER_TENANT_PER_HOUR: '7',
      COLLECTOR_COMPLAINTS_OUTCOME_HEADER: 'X-Other-Header',
    }).complaints;
    expect(config?.perTenantPerHour).toBe(7);
    expect(config?.outcomeHeader).toBe('x-other-header');
  });

  it.each(Object.keys(COMPLAINTS))('refuses a partial set: %s alone', (name) => {
    expect(() =>
      loadConfig({ ...ENV, [name]: COMPLAINTS[name as keyof typeof COMPLAINTS] })
    ).toThrow(/must be set together/);
  });

  it('refuses the token as a value', () => {
    expect(() => loadConfig({ ...ENV, ...COMPLAINTS, COLLECTOR_COMPLAINTS_TOKEN: 'abc' })).toThrow(
      /never the value/
    );
  });

  it('refuses to be set without the Sweego relay: no message could ever match', () => {
    const { COLLECTOR_SWEEGO_SMTP_HOST: _host, ...rest } = ENV;
    expect(() => loadConfig({ ...rest, ...COMPLAINTS })).toThrow(/COLLECTOR_SWEEGO_SMTP_HOST/);
  });

  it.each([
    ['not a URL', 'receiver'],
    ['a non-http scheme', 'ftp://receiver:9000'],
    ['one with credentials', 'http://user:pass@receiver:9000'],
  ])('refuses a receiver address that is %s', (_name, url) => {
    expect(() => loadConfig({ ...ENV, ...COMPLAINTS, COLLECTOR_COMPLAINTS_URL: url })).toThrow();
  });

  it('refuses a header name that is not a plain token', () => {
    expect(() =>
      loadConfig({ ...ENV, ...COMPLAINTS, COLLECTOR_COMPLAINTS_OUTCOME_HEADER: 'bad name:' })
    ).toThrow(/not a header name/);
  });
});

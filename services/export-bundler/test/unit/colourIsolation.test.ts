import { describe, expect, it } from 'vitest';
import {
  BULK_EMAIL_SINK,
  exportColourOverrides,
  isolateExportColour,
  MAIL_TRANSPORT,
  SCHEDULING_ADAPTER,
} from '../../src/colourIsolation.js';

const TENANT_ENV = {
  url: 'https://acme.example',
  database__client: 'mysql',
  database__connection__password: 'synthetic-pw',
  mail__transport: 'SMTP',
  mail__options__host: 'mx1.example',
  mail__options__port: '587',
  mail__options__auth__user: 'acme',
  mail__options__auth__pass: 'synthetic-mail-pw',
  mail__from: 'acme@example.test',
  bulkEmail__mailgun__baseUrl: 'https://spool.example/v3',
  bulkEmail__mailgun__apiKey: 'synthetic-bulk-key',
  bulkEmail__mailgun__domain: 'acme.example',
  adapters__scheduling__active: 'scheduling-default',
  adapters__scheduling__someOption: 'x',
  updateCheck__forceUpdate: 'true',
  privacy__useUpdateCheck: 'true',
  adapters__sso__active: 'BreakGlassSSO',
};

describe('isolateExportColour', () => {
  const env = isolateExportColour(TENANT_ENV, 'fixed-secret');

  it("sends no mail: Ghost's stub transport, and none of the tenant's mail options survive", () => {
    expect(env.mail__transport).toBe(MAIL_TRANSPORT);
    expect(MAIL_TRANSPORT).toBe('stub');
    for (const key of Object.keys(env)) {
      expect(key.startsWith('mail__') && key !== 'mail__transport').toBe(false);
    }
    expect(Object.values(env)).not.toContain('synthetic-mail-pw');
    expect(Object.values(env)).not.toContain('mx1.example');
  });

  it("sends no newsletter: bulk email points at a refused loopback port, never the tenant's spool", () => {
    expect(env.bulkEmail__mailgun__baseUrl).toBe(BULK_EMAIL_SINK);
    expect(new URL(BULK_EMAIL_SINK).hostname).toBe('127.0.0.1');
    expect(Object.values(env)).not.toContain('synthetic-bulk-key');
    expect(Object.values(env)).not.toContain('https://spool.example/v3');
  });

  it('runs no scheduler: the no-op adapter, with every other scheduling key dropped', () => {
    expect(env.adapters__scheduling__active).toBe(SCHEDULING_ADAPTER);
    expect(SCHEDULING_ADAPTER).toBe('SchedulingDisabled');
    expect(env).not.toHaveProperty('adapters__scheduling__someOption');
  });

  it('runs no email-analytics or click-tracking job, and no update check', () => {
    expect(env.backgroundJobs__emailAnalytics).toBe('false');
    expect(env.backgroundJobs__clickTrackingLastSeenAtUpdater).toBe('false');
    expect(env.privacy__useUpdateCheck).toBe('false');
    expect(env).not.toHaveProperty('updateCheck__forceUpdate');
  });

  it("keeps Stripe's webhook manager in local mode", () => {
    expect(env.WEBHOOK_SECRET).toBe('fixed-secret');
  });

  it("keeps everything else the tenant's colour boots with", () => {
    expect(env.url).toBe('https://acme.example');
    expect(env.database__connection__password).toBe('synthetic-pw');
    expect(env.adapters__sso__active).toBe('BreakGlassSSO');
  });

  it('applies every override, whatever the tenant env holds', () => {
    expect(isolateExportColour({}, 's')).toEqual(exportColourOverrides('s'));
  });

  it('draws a fresh webhook secret per run when none is given', () => {
    const a = isolateExportColour({}).WEBHOOK_SECRET;
    const b = isolateExportColour({}).WEBHOOK_SECRET;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

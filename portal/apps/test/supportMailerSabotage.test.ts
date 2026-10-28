import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmtpSupportMailer } from '../src/tenant/supportSmtpMailer.js';
import {
  cleartextOnly,
  newCertificate,
  trusted,
  untrustedCertificate,
  wrongHostname,
  type CreateMailer,
} from './supportSmtpScenarios.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

interface MailerModule {
  readonly createSmtpSupportMailer: CreateMailer;
}

const cert = newCertificate();

beforeAll(clearMutants);
afterAll(clearMutants);

describe('sabotage: the certificate check is what keeps an untrusted server out', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(importSabotaged('noop', 'text that is not in the module', 'x')).rejects.toThrow(
      'exactly once'
    );
  });

  it('RED: with verification switched off, an untrusted certificate gets the login and the message', async () => {
    const broken = await importSabotaged<MailerModule>(
      'verification-off',
      'rejectUnauthorized: true',
      'rejectUnauthorized: false'
    );
    expect((await trusted(broken.createSmtpSupportMailer, cert)).result).toBe('DELIVERED');

    const untrusted = await untrustedCertificate(broken.createSmtpSupportMailer, cert);
    expect(untrusted.result).toBe('DELIVERED');
    expect(untrusted.auths).toBe(1);
    expect(untrusted.delivered).toHaveLength(1);

    const wrongName = await wrongHostname(broken.createSmtpSupportMailer, cert);
    expect(wrongName.result).toBe('DELIVERED');
    expect(wrongName.auths).toBe(1);
    expect(wrongName.delivered).toHaveLength(1);
  });

  it('GREEN: the real module turns both away before any login, and the control still delivers', async () => {
    expect((await trusted(createSmtpSupportMailer, cert)).result).toBe('DELIVERED');
    for (const run of [untrustedCertificate, wrongHostname]) {
      const outcome = await run(createSmtpSupportMailer, cert);
      expect(outcome.result).toBe('TLS_FAILED');
      expect(outcome.auths).toBe(0);
      expect(outcome.delivered).toHaveLength(0);
    }
  });
});

describe('sabotage: requiring TLS is what keeps the login off a cleartext connection', () => {
  it('RED: without it, the login is sent in the clear and the message is delivered', async () => {
    const broken = await importSabotaged<MailerModule>(
      'tls-optional',
      'requireTLS: true',
      'requireTLS: false'
    );
    const outcome = await cleartextOnly(broken.createSmtpSupportMailer, cert);
    expect(outcome.auths).toBeGreaterThanOrEqual(1);
    expect(outcome.secureAuths).toBe(0);
    expect(outcome.result).toBe('DELIVERED');
    expect(outcome.delivered).toHaveLength(1);
  });

  it('GREEN: the real module records no login and no message against the same server', async () => {
    const outcome = await cleartextOnly(createSmtpSupportMailer, cert);
    expect(outcome.result).toBe('TLS_FAILED');
    expect(outcome.auths).toBe(0);
    expect(outcome.delivered).toHaveLength(0);
  });
});

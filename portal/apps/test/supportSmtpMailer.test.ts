import { describe, expect, it } from 'vitest';
import {
  MAILER_ERROR_CODES,
  SupportMailerError,
  createSmtpSupportMailer,
  toMailerErrorCode,
} from '../src/tenant/supportSmtpMailer.js';
import { certificateIsUsableFor } from './selfSignedCert.js';
import { FAKE_CONTACT, FAKE_RECIPIENT, FAKE_SENDER } from './supportHarness.js';
import {
  BODY_MARKER,
  MESSAGE,
  TEST_PASSWORD,
  cleartextOnly,
  harnessOptions,
  mailerOptions,
  newCertificate,
  sendOnce,
  trusted,
  untrustedCertificate,
  wrongHostname,
} from './supportSmtpScenarios.js';
import { closedPort } from './supportSmtpServer.js';

const cert = newCertificate();
const create = createSmtpSupportMailer;

describe('the generated test certificate', () => {
  it('parses, names localhost and is inside its validity window', () => {
    expect(certificateIsUsableFor(cert.cert, 'localhost')).toBe(true);
    expect(certificateIsUsableFor(cert.cert, 'other.invalid')).toBe(false);
  });

  it('is not usable outside its window', () => {
    const later = new Date(Date.now() + 3 * 86_400_000);
    expect(certificateIsUsableFor(cert.cert, 'localhost', later)).toBe(false);
  });
});

describe('the control: a trusted certificate delivers (judges every rejection below)', () => {
  it('delivers one message after one AUTH, on an encrypted session, with the right envelope and headers', async () => {
    const outcome = await trusted(create, cert);
    expect(outcome.result).toBe('DELIVERED');
    expect(outcome.auths).toBe(1);
    expect(outcome.secureAuths).toBe(1);
    expect(outcome.delivered).toHaveLength(1);
    const [message] = outcome.delivered;
    expect(message?.from).toBe(FAKE_SENDER);
    expect(message?.to).toEqual([FAKE_RECIPIENT]);
    const raw = message?.raw ?? '';
    expect(raw).toContain(`Reply-To: ${FAKE_CONTACT}`);
    expect(raw).toContain('Subject: SUPPORT_TICKET');
    expect(raw).toContain(`From: ${FAKE_SENDER}`);
    expect(raw).toContain(`To: ${FAKE_RECIPIENT}`);
    expect(raw).toContain(`${BODY_MARKER} first line`);
    expect(raw).toContain('second line');
  });

  it('delivers over implicit TLS as well', async () => {
    const outcome = await sendOnce(create, harnessOptions(cert, { security: 'implicit' }), (port) =>
      mailerOptions(port, cert, { security: 'IMPLICIT' })
    );
    expect(outcome.result).toBe('DELIVERED');
    expect(outcome.auths).toBe(1);
    expect(outcome.secureAuths).toBe(1);
    expect(outcome.delivered).toHaveLength(1);
  });
});

describe('the server certificate is always verified', () => {
  it('rejects a certificate the client was not told to trust, before any login', async () => {
    const outcome = await untrustedCertificate(create, cert);
    expect(outcome.result).toBe('TLS_FAILED');
    expect(outcome.failures).toEqual(['TLS_FAILED']);
    expect(outcome.connections).toBeGreaterThanOrEqual(1);
    expect(outcome.auths).toBe(0);
    expect(outcome.delivered).toHaveLength(0);
  });

  it('rejects a trusted certificate presented for the wrong name, before any login', async () => {
    const outcome = await wrongHostname(create, cert);
    expect(outcome.result).toBe('TLS_FAILED');
    expect(outcome.connections).toBeGreaterThanOrEqual(1);
    expect(outcome.auths).toBe(0);
    expect(outcome.delivered).toHaveLength(0);
  });

  it('rejects an untrusted certificate over implicit TLS', async () => {
    const outcome = await sendOnce(create, harnessOptions(cert, { security: 'implicit' }), (port) =>
      mailerOptions(port, cert, { security: 'IMPLICIT', tlsOptions: undefined })
    );
    expect(outcome.result).toBe('TLS_FAILED');
    expect(outcome.auths).toBe(0);
    expect(outcome.delivered).toHaveLength(0);
  });

  it('does not let a caller switch verification off through the TLS options', async () => {
    const outcome = await sendOnce(create, harnessOptions(cert), (port) =>
      mailerOptions(port, cert, {
        tlsOptions: { rejectUnauthorized: false } as never,
      })
    );
    expect(outcome.result).toBe('TLS_FAILED');
    expect(outcome.auths).toBe(0);
  });
});

describe('there is no fall back to cleartext', () => {
  it('refuses a server that offers no TLS: no login, no message', async () => {
    const outcome = await cleartextOnly(create, cert);
    expect(outcome.result).toBe('TLS_FAILED');
    expect(outcome.connections).toBeGreaterThanOrEqual(1);
    expect(outcome.auths).toBe(0);
    expect(outcome.delivered).toHaveLength(0);
  });
});

describe('every failure is one code from the closed set', () => {
  it('CONNECT_FAILED: nothing is listening', async () => {
    const port = await closedPort();
    const failures: string[] = [];
    const mailer = create({
      ...mailerOptions(port, cert),
      onFailure: (code) => failures.push(code),
    });
    await expect(mailer.send(MESSAGE)).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    expect(failures).toEqual(['CONNECT_FAILED']);
  });

  it('AUTH_FAILED: the login is refused, and nothing is delivered', async () => {
    const outcome = await sendOnce(create, harnessOptions(cert), (port) =>
      mailerOptions(port, cert, { password: 'WRONG_PASSWORD_MARKER' })
    );
    expect(outcome.result).toBe('AUTH_FAILED');
    expect(outcome.failures).toEqual(['AUTH_FAILED']);
    expect(outcome.auths).toBe(1);
    expect(outcome.delivered).toHaveLength(0);
  });

  it('REJECTED: the server refuses the recipient', async () => {
    const outcome = await sendOnce(create, harnessOptions(cert, { rcptRejectCode: 550 }), (port) =>
      mailerOptions(port, cert)
    );
    expect(outcome.result).toBe('REJECTED');
    expect(outcome.failures).toEqual(['REJECTED']);
    expect(outcome.delivered).toHaveLength(0);
  });

  it('TIMEOUT: the greeting never comes', async () => {
    const outcome = await sendOnce(
      create,
      harnessOptions(cert, { greetingDelayMs: 3000 }),
      (port) =>
        mailerOptions(port, cert, {
          timeouts: { connectionMs: 300, greetingMs: 300, socketMs: 300 },
        })
    );
    expect(outcome.result).toBe('TIMEOUT');
    expect(outcome.failures).toEqual(['TIMEOUT']);
    expect(outcome.auths).toBe(0);
  });

  it('SEND_FAILED: the server turns the message down at the end of DATA', async () => {
    const outcome = await sendOnce(create, harnessOptions(cert, { dataRejectCode: 451 }), (port) =>
      mailerOptions(port, cert)
    );
    expect(outcome.result).toBe('SEND_FAILED');
    expect(outcome.failures).toEqual(['SEND_FAILED']);
    expect(outcome.delivered).toHaveLength(0);
  });

  it('the mapper sorts a library error by its own code and falls through to SEND_FAILED', () => {
    const coded = (code: string): Error => Object.assign(new Error('x'), { code });
    expect(toMailerErrorCode(coded('ETIMEDOUT'))).toBe('TIMEOUT');
    expect(toMailerErrorCode(coded('EAUTH'))).toBe('AUTH_FAILED');
    expect(toMailerErrorCode(coded('EENVELOPE'))).toBe('REJECTED');
    expect(toMailerErrorCode(coded('ETLS'))).toBe('TLS_FAILED');
    expect(toMailerErrorCode(coded('EREQUIRETLS'))).toBe('TLS_FAILED');
    expect(toMailerErrorCode(coded('ECONNECTION'))).toBe('CONNECT_FAILED');
    expect(toMailerErrorCode(coded('ESOCKET'))).toBe('CONNECT_FAILED');
    const certificateProblem = Object.assign(new Error('self-signed certificate'), {
      code: 'ESOCKET',
    });
    expect(toMailerErrorCode(certificateProblem)).toBe('TLS_FAILED');
    const refusedConnection = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ESOCKET',
      syscall: 'connect',
    });
    expect(toMailerErrorCode(refusedConnection)).toBe('CONNECT_FAILED');
    const resetDuringTls = Object.assign(new Error('read ECONNRESET during the TLS handshake'), {
      code: 'ESOCKET',
      syscall: 'read',
    });
    expect(toMailerErrorCode(resetDuringTls)).toBe('CONNECT_FAILED');
    expect(toMailerErrorCode(coded('EMESSAGE'))).toBe('SEND_FAILED');
    expect(toMailerErrorCode(new Error('no code'))).toBe('SEND_FAILED');
    expect(toMailerErrorCode('a string')).toBe('SEND_FAILED');
    expect(toMailerErrorCode(null)).toBe('SEND_FAILED');
    expect(toMailerErrorCode({ code: 42 })).toBe('SEND_FAILED');
  });

  it('has a fixed message for every code and nothing else on the error', () => {
    for (const code of MAILER_ERROR_CODES) {
      const error = new SupportMailerError(code);
      expect(error.name).toBe('SupportMailerError');
      expect(error.code).toBe(code);
      expect(error.cause).toBeUndefined();
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('what an error and the failure callback may carry', () => {
  const secrets = [
    TEST_PASSWORD,
    'WRONG_PASSWORD_MARKER',
    BODY_MARKER,
    FAKE_RECIPIENT,
    FAKE_SENDER,
    FAKE_CONTACT,
    '127.0.0.1',
  ];

  function everythingPrinted(error: unknown, failures: readonly string[]): string {
    const thrown = error as Error;
    return [
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)),
      String(thrown.message),
      String(thrown.stack),
      JSON.stringify(failures),
    ].join('\n');
  }

  it.each([
    [
      'AUTH_FAILED',
      () =>
        sendOnce(create, harnessOptions(cert), (port) =>
          mailerOptions(port, cert, { password: 'WRONG_PASSWORD_MARKER' })
        ),
    ],
    [
      'REJECTED',
      () =>
        sendOnce(create, harnessOptions(cert, { rcptRejectCode: 550 }), (port) =>
          mailerOptions(port, cert)
        ),
    ],
  ])('%s carries none of the password, the body, the addresses or the host', async (code, run) => {
    const outcome = await run();
    expect(outcome.result).toBe(code);
    const printed = everythingPrinted(outcome.error, outcome.failures);
    for (const secret of secrets) expect(printed).not.toContain(secret);
    expect(outcome.failures).toEqual([code]);
  });
});

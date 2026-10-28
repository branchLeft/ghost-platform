import type { SupportMailer, SupportMessage } from '../src/tenant/supportMailer.js';
import type {
  SmtpSupportMailerOptions,
  SupportMailerErrorCode,
} from '../src/tenant/supportSmtpMailer.js';
import { generateTestCertificate, type TestCertificate } from './selfSignedCert.js';
import { FAKE_CONTACT, FAKE_RECIPIENT, FAKE_SENDER } from './supportHarness.js';
import {
  startSmtpHarness,
  type SmtpHarness,
  type SmtpHarnessOptions,
} from './supportSmtpServer.js';

export const TEST_PASSWORD = 'PASSWORD_MARKER_91c2';
export const BODY_MARKER = 'BODY_MARKER_7f3a';

export const MESSAGE: SupportMessage = {
  to: FAKE_RECIPIENT,
  from: FAKE_SENDER,
  replyTo: FAKE_CONTACT,
  subject: 'SUPPORT_TICKET',
  body: `${BODY_MARKER} first line\nsecond line`,
};

export type CreateMailer = (options: SmtpSupportMailerOptions) => SupportMailer;

/** What a send did, read from the server's side as well as the caller's. */
export interface Outcome {
  readonly result: 'DELIVERED' | SupportMailerErrorCode | 'UNRECOGNISED';
  readonly error: unknown;
  readonly failures: readonly SupportMailerErrorCode[];
  readonly connections: number;
  readonly auths: number;
  readonly secureAuths: number;
  readonly delivered: SmtpHarness['delivered'];
}

export function newCertificate(): TestCertificate {
  return generateTestCertificate({ dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] });
}

export function harnessOptions(
  cert: TestCertificate,
  overrides: Partial<SmtpHarnessOptions> = {}
): SmtpHarnessOptions {
  return {
    cert,
    security: 'starttls',
    user: FAKE_SENDER,
    password: TEST_PASSWORD,
    ...overrides,
  };
}

/** Defaults to the trusted setup: the test certificate as the only authority, named localhost. */
export function mailerOptions(
  port: number,
  cert: TestCertificate,
  overrides: Partial<SmtpSupportMailerOptions> = {}
): SmtpSupportMailerOptions {
  return {
    host: '127.0.0.1',
    port,
    security: 'STARTTLS',
    user: FAKE_SENDER,
    password: TEST_PASSWORD,
    tlsOptions: { ca: cert.cert, servername: 'localhost' },
    ...overrides,
  };
}

export async function sendOnce(
  create: CreateMailer,
  server: SmtpHarnessOptions,
  mailer: (port: number) => SmtpSupportMailerOptions
): Promise<Outcome> {
  const harness = await startSmtpHarness(server);
  const failures: SupportMailerErrorCode[] = [];
  let result: Outcome['result'] = 'DELIVERED';
  let error: unknown = null;
  try {
    const options = mailer(harness.port);
    await create({ ...options, onFailure: (code) => failures.push(code) }).send(MESSAGE);
  } catch (caught) {
    error = caught;
    const code = (caught as { code?: SupportMailerErrorCode }).code;
    result = code ?? 'UNRECOGNISED';
  } finally {
    await harness.close();
  }
  return {
    result,
    error,
    failures,
    connections: harness.connections(),
    auths: harness.auths(),
    secureAuths: harness.secureAuths(),
    delivered: harness.delivered,
  };
}

/** The server's certificate is trusted and named: the setup every rejection is judged against. */
export function trusted(create: CreateMailer, cert: TestCertificate): Promise<Outcome> {
  return sendOnce(create, harnessOptions(cert), (port) => mailerOptions(port, cert));
}

/** A valid certificate the client was never told to trust. */
export function untrustedCertificate(
  create: CreateMailer,
  cert: TestCertificate
): Promise<Outcome> {
  return sendOnce(create, harnessOptions(cert), (port) =>
    mailerOptions(port, cert, { tlsOptions: undefined })
  );
}

/** A trusted certificate presented for a different name than the one asked for. */
export function wrongHostname(create: CreateMailer, cert: TestCertificate): Promise<Outcome> {
  return sendOnce(create, harnessOptions(cert), (port) =>
    mailerOptions(port, cert, { tlsOptions: { ca: cert.cert, servername: 'other.invalid' } })
  );
}

/** A server that offers no TLS and, unlike a real one, would take a login in the clear. */
export function cleartextOnly(create: CreateMailer, cert: TestCertificate): Promise<Outcome> {
  return sendOnce(create, harnessOptions(cert, { security: 'none' }), (port) =>
    mailerOptions(port, cert)
  );
}

import { createServer, type AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import type { TestCertificate } from './selfSignedCert.js';

export interface DeliveredMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}

export interface SmtpHarnessOptions {
  readonly cert: TestCertificate;
  /** `starttls` advertises it, `implicit` listens encrypted, `none` offers no TLS at all. */
  readonly security: 'starttls' | 'implicit' | 'none';
  readonly user: string;
  readonly password: string;
  /** Answer every RCPT TO with this response code. */
  readonly rcptRejectCode?: number;
  /** Answer the end of DATA with this response code. */
  readonly dataRejectCode?: number;
  readonly greetingDelayMs?: number;
}

/**
 * A real SMTP server on 127.0.0.1. Cleartext AUTH is allowed on purpose, so a
 * client that fails to insist on TLS shows up as an AUTH it should not have
 * made, counted at the protocol level.
 */
export interface SmtpHarness {
  readonly port: number;
  readonly delivered: DeliveredMessage[];
  /** Connections reached, whatever happened on them. */
  connections(): number;
  /** AUTH commands received, from any session. */
  auths(): number;
  /** Of those, how many arrived on an encrypted session. */
  secureAuths(): number;
  close(): Promise<void>;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function refusal(responseCode: number): Error {
  return Object.assign(new Error('refused by the test server'), { responseCode });
}

export async function startSmtpHarness(options: SmtpHarnessOptions): Promise<SmtpHarness> {
  const delivered: DeliveredMessage[] = [];
  let connections = 0;
  let auths = 0;
  let secureAuths = 0;

  const serverOptions: SMTPServerOptions = {
    key: options.cert.key,
    cert: options.cert.cert,
    secure: options.security === 'implicit',
    disabledCommands: options.security === 'none' ? ['STARTTLS'] : [],
    allowInsecureAuth: true,
    logger: false,
    onConnect(_session, callback) {
      connections += 1;
      if (options.greetingDelayMs === undefined) {
        callback();
      } else {
        setTimeout(callback, options.greetingDelayMs).unref();
      }
    },
    onAuth(auth, session, callback) {
      auths += 1;
      if (session.secure) secureAuths += 1;
      if (auth.username === options.user && auth.password === options.password) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid username or password'));
      }
    },
    onRcptTo(_address, _session, callback) {
      callback(options.rcptRejectCode === undefined ? null : refusal(options.rcptRejectCode));
    },
    onData(stream, session, callback) {
      void readAll(stream).then((raw) => {
        if (options.dataRejectCode !== undefined) {
          callback(refusal(options.dataRejectCode));
          return;
        }
        delivered.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((recipient) => recipient.address),
          raw,
        });
        callback();
      });
    },
  };

  const server = new SMTPServer(serverOptions);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.server.address() as AddressInfo).port;

  return {
    port,
    delivered,
    connections: () => connections,
    auths: () => auths,
    secureAuths: () => secureAuths,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}

/** A port nothing listens on: bind one, note it, release it. */
export async function closedPort(): Promise<number> {
  const placeholder = createServer();
  await new Promise<void>((resolve) => placeholder.listen(0, '127.0.0.1', resolve));
  const port = (placeholder.address() as AddressInfo).port;
  await new Promise<void>((resolve) => placeholder.close(() => resolve()));
  return port;
}

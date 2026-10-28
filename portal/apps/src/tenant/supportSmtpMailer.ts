import nodemailer from 'nodemailer';
import type { SupportMailer, SupportMessage } from './supportMailer.js';

/** The closed set of reasons a send failed. Nothing else leaves this module. */
export const MAILER_ERROR_CODES = [
  'CONNECT_FAILED',
  'TLS_FAILED',
  'AUTH_FAILED',
  'REJECTED',
  'TIMEOUT',
  'SEND_FAILED',
] as const;

export type SupportMailerErrorCode = (typeof MAILER_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<SupportMailerErrorCode, string>> = {
  CONNECT_FAILED: 'the mail server could not be reached',
  TLS_FAILED: 'a secure connection to the mail server could not be made',
  AUTH_FAILED: 'the mail server refused the login',
  REJECTED: 'the mail server refused the sender or the recipient',
  TIMEOUT: 'the mail server did not answer in time',
  SEND_FAILED: 'the mail server did not accept the message',
};

/**
 * A send failure carrying a code and a fixed message. It never holds the
 * library's error, an address, the body or any text the server sent back.
 */
export class SupportMailerError extends Error {
  readonly code: SupportMailerErrorCode;

  constructor(code: SupportMailerErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SupportMailerError';
    this.code = code;
  }
}

export type SmtpSecurity = 'STARTTLS' | 'IMPLICIT';

export interface SmtpTimeouts {
  readonly connectionMs: number;
  readonly greetingMs: number;
  readonly socketMs: number;
}

/** The only certificate settings a caller may touch; verification itself is fixed on. */
export interface SmtpTlsOptions {
  readonly ca?: string;
  readonly servername?: string;
}

export interface SmtpSupportMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly user: string;
  readonly password: string;
  readonly tlsOptions?: SmtpTlsOptions;
  readonly timeouts?: SmtpTimeouts;
  /** Called with the short code of each failed send, before the error is thrown. */
  readonly onFailure?: (code: SupportMailerErrorCode) => void;
}

const DEFAULT_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 30_000,
};

const TLS_LIBRARY_CODES: ReadonlySet<string> = new Set(['ETLS', 'EREQUIRETLS']);

// The library files a certificate failure under its socket code and replaces
// Node's own code, so a failed verification arrives as ESOCKET with no
// `syscall` and a message about the certificate. A refused or reset
// connection carries the `syscall` that failed.
const SOCKET_CODES: ReadonlySet<string> = new Set(['ESOCKET', 'ECONNECTION']);
const TLS_MESSAGE = /certificate|altnames|\bTLS\b|\bSSL\b|handshake/i;

function stringProperty(error: unknown, name: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(name in error)) return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function socketCode(error: unknown): SupportMailerErrorCode {
  const failedInTheNetwork = stringProperty(error, 'syscall') !== undefined;
  const aboutTls = TLS_MESSAGE.test(stringProperty(error, 'message') ?? '');
  return !failedInTheNetwork && aboutTls ? 'TLS_FAILED' : 'CONNECT_FAILED';
}

/**
 * Sorts whatever the library threw into the closed set, by its own `code`
 * (pinned to what it emits in the tests). An error it does not recognise is
 * SEND_FAILED, never a guess.
 */
export function toMailerErrorCode(error: unknown): SupportMailerErrorCode {
  const code = stringProperty(error, 'code');
  if (code === undefined) return 'SEND_FAILED';
  if (code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'EAUTH') return 'AUTH_FAILED';
  if (code === 'EENVELOPE') return 'REJECTED';
  if (TLS_LIBRARY_CODES.has(code)) return 'TLS_FAILED';
  if (SOCKET_CODES.has(code)) return socketCode(error);
  return 'SEND_FAILED';
}

/**
 * A `SupportMailer` that submits over authenticated SMTP. STARTTLS upgrades
 * before it logs in and refuses to continue in the clear; IMPLICIT starts
 * encrypted. The server's certificate is always verified.
 */
export function createSmtpSupportMailer(options: SmtpSupportMailerOptions): SupportMailer {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.security === 'IMPLICIT',
    requireTLS: true,
    ignoreTLS: false,
    auth: { user: options.user, pass: options.password },
    tls: {
      ...options.tlsOptions,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });

  return {
    async send(message: SupportMessage): Promise<void> {
      try {
        await transport.sendMail({
          envelope: { from: message.from, to: [message.to] },
          from: message.from,
          to: message.to,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.body,
        });
      } catch (error) {
        const code = toMailerErrorCode(error);
        options.onFailure?.(code);
        throw new SupportMailerError(code);
      }
    },
  };
}

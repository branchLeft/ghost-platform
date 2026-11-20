import { readFileSync } from 'node:fs';
import nodemailer, { type Transporter } from 'nodemailer';
import type { DeliveryClient } from './deliveryClient.js';
import type { WireMessage } from './drainClient.js';
import { outcomeIdFor } from './sentJournal.js';
import { SweegoSubmissionError, classifySweegoError } from './sweegoFailure.js';

export interface SweegoTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  logger: false;
  debug: false;
}

export interface SweegoDeliveryClientOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Path of the root-readable file that holds the relay credential. The value is never in config. */
  passFile: string;
  /** Bounds connecting, the greeting and every wait on the relay, so a down relay fails fast. */
  timeoutMs: number;
  /**
   * Refuse to send the credential over a connection that is not encrypted.
   * Always true in the process; only a test against a local fake relay that
   * offers no TLS turns it off.
   */
  requireTls?: boolean;
  /**
   * Name of the header that carries the message's correlation value
   * (`outcomeIdFor`), which a complaint echoes back. Any header of that name the
   * message already carries is removed first: a value the message's author chose
   * must never be able to name another message. Unset, no header is added.
   */
  outcomeHeader?: string;
  transporterFactory?: (options: SweegoTransportOptions) => Transporter;
}

/** Reads the relay credential. Throws a classified, content-free error if it cannot. */
function readCredential(passFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(passFile, 'utf8');
  } catch {
    throw new SweegoSubmissionError('credential');
  }
  const credential = raw.replace(/[\r\n]+$/, '');
  if (credential === '') {
    throw new SweegoSubmissionError('credential');
  }
  return credential;
}

function withOutcomeHeader(message: WireMessage, name: string | undefined): Record<string, string> {
  if (name === undefined) {
    return message.headers;
  }
  const wanted = name.toLowerCase();
  const kept = Object.entries(message.headers).filter(([key]) => key.toLowerCase() !== wanted);
  return { ...Object.fromEntries(kept), [name]: outcomeIdFor(message) };
}

/**
 * Authenticated SMTP submission to the Sweego relay. The credential is read
 * from its file for each message and handed to one transporter that lives for
 * that message alone, so it is held nowhere else: not in config, not in this
 * object, not in a pooled connection. Every failure leaves as a
 * `SweegoSubmissionError` built from a reason and a reply number only, never
 * the relay's text, so nothing that reaches a log line can carry an address or
 * the credential. See ../README.md#sweegodeliveryclient-createsweegodeliveryclient.
 */
export function createSweegoDeliveryClient(opts: SweegoDeliveryClientOptions): DeliveryClient {
  const makeTransporter =
    opts.transporterFactory ?? ((options) => nodemailer.createTransport(options));

  async function deliver(message: WireMessage): Promise<void> {
    const pass = readCredential(opts.passFile);
    const transporter = makeTransporter({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      requireTLS: !opts.secure && opts.requireTls !== false,
      auth: { user: opts.user, pass },
      connectionTimeout: opts.timeoutMs,
      greetingTimeout: opts.timeoutMs,
      socketTimeout: opts.timeoutMs,
      logger: false,
      debug: false,
    });
    const headers = withOutcomeHeader(message, opts.outcomeHeader);
    try {
      await transporter.sendMail({
        from: message.from,
        to: message.toName ? { name: message.toName, address: message.to } : message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers,
      });
    } catch (error) {
      throw classifySweegoError(error);
    } finally {
      transporter.close();
    }
  }

  return {
    deliver,
    close() {
      // Nothing is held between messages.
    },
  };
}

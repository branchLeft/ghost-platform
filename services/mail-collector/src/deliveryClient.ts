import nodemailer, { type Transporter } from 'nodemailer';
import type { WireMessage } from './drainClient.js';
import { encodeOutcomeMessageId } from './outcomeId.js';

export interface DeliveryClientOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /**
   * Opt-in. When set, each submission carries a Message-ID that names the
   * message, its claim generation and its spool, an envelope sender of
   * `returnPath` (where mx1 sends delivery status notifications) and a DSN
   * request for success, failure and delay. Unset, a submission is exactly
   * what it was before this option existed.
   */
  outcomes?: { returnPath: string };
  transporterFactory?: (opts: DeliveryClientOptions) => Transporter;
}

export interface DeliveryClient {
  /** `targetId` names the spool the message came from; only used when outcomes are on. */
  deliver(message: WireMessage, targetId?: string): Promise<void>;
  close(): void;
}

/**
 * Authenticated SMTP submission to mx1 (HLD §03: "the only two inbound
 * channels anywhere are HTTPS at an edge and authenticated SMTP submission
 * to mx1"). One transporter, reused across every drained host and every
 * message -- this is the one egress connection the whole estate's mail now
 * goes through, which is exactly why the throttle in throttle.ts sits next
 * to it rather than per-host.
 */
export function createDeliveryClient(opts: DeliveryClientOptions): DeliveryClient {
  const makeTransporter = opts.transporterFactory ?? defaultTransporterFactory;
  const transporter = makeTransporter(opts);

  async function deliver(message: WireMessage, targetId?: string): Promise<void> {
    const outcomeFields =
      opts.outcomes && targetId !== undefined
        ? {
            messageId: encodeOutcomeMessageId({
              targetId,
              id: message.id,
              drainCount: message.drainCount,
            }),
            envelope: { from: opts.outcomes.returnPath, to: message.to },
            dsn: {
              id: message.id,
              return: 'headers' as const,
              notify: ['success', 'failure', 'delay'] as Array<'success' | 'failure' | 'delay'>,
              recipient: message.to,
            },
          }
        : {};
    await transporter.sendMail({
      ...outcomeFields,
      from: message.from,
      to: message.toName ? { name: message.toName, address: message.to } : message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    });
  }

  return {
    deliver,
    close() {
      transporter.close();
    },
  };
}

function defaultTransporterFactory(opts: DeliveryClientOptions): Transporter {
  return nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
  });
}

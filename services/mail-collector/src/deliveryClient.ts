import nodemailer, { type Transporter } from 'nodemailer';
import type { WireMessage } from './drainClient.js';
import { laneReturnPath, type Mx1LaneReturnPaths } from './mx1Lane.js';
import { encodeOutcomeMessageId } from './outcomeId.js';
import { mailClassOf } from './sendingTarget.js';

export interface DeliveryClientOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /**
   * The envelope sender of every submission, by lane (`mx1Lane`): mx1 chooses
   * the source IP by its domain. Independent of `outcomes`. Unset, the
   * envelope sender is whatever `outcomes` says, else the From address.
   */
  lanes?: Mx1LaneReturnPaths;
  /**
   * Opt-in. When set, each submission carries a Message-ID that names the
   * message, its claim generation and its spool, and a DSN request for
   * success, failure and delay. `returnPath` is the envelope sender (where mx1
   * sends delivery status notifications), required without `lanes` and refused
   * beside it: two settings must not name the one envelope sender. Unset, a
   * submission is exactly what it was before this option existed.
   */
  outcomes?: { returnPath?: string };
  transporterFactory?: (opts: DeliveryClientOptions) => Transporter;
}

export interface DeliveryClient {
  /**
   * `targetId` names the spool the message came from; only used when outcomes
   * are on. `context.demo` marks mail from a demo host, which rides the
   * newsletter lane; only the mx1 client reads it.
   */
  deliver(message: WireMessage, targetId?: string, context?: { demo: boolean }): Promise<void>;
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
  if (opts.lanes && opts.outcomes?.returnPath !== undefined) {
    throw new Error(
      'outcomes.returnPath cannot be set beside lanes: the lane return paths are the envelope sender'
    );
  }
  if (opts.outcomes && !opts.lanes && !opts.outcomes.returnPath) {
    throw new Error('outcomes need a return path, or lane return paths to send from');
  }
  const transporter = makeTransporter(opts);

  async function deliver(
    message: WireMessage,
    targetId?: string,
    context?: { demo: boolean }
  ): Promise<void> {
    // The lane return path is the envelope sender of every submission, outcome
    // path or not. Without lanes, the outcome path's single return path is
    // used when a spool is named, as before.
    const sender = opts.lanes
      ? laneReturnPath(opts.lanes, mailClassOf(message.emailId), context?.demo === true)
      : opts.outcomes && targetId !== undefined
        ? opts.outcomes.returnPath
        : undefined;
    const envelopeFields =
      sender !== undefined ? { envelope: { from: sender, to: message.to } } : {};
    const outcomeFields =
      opts.outcomes && targetId !== undefined
        ? {
            messageId: encodeOutcomeMessageId({
              targetId,
              id: message.id,
              drainCount: message.drainCount,
            }),
            dsn: {
              id: message.id,
              return: 'headers' as const,
              notify: ['success', 'failure', 'delay'] as Array<'success' | 'failure' | 'delay'>,
              recipient: message.to,
            },
          }
        : {};
    await transporter.sendMail({
      ...envelopeFields,
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

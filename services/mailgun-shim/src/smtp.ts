import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';

export type { Transporter };

export interface DeliveryHostConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

export function createDeliveryTransport(config: DeliveryHostConfig): Transporter {
  // Doc 13 §2.2/§2.3: the shim submits over SMTP AUTH on 587 to a delivery
  // host outside GCP — never talks to Mailgun's service, never opens port
  // 25 itself (that hop belongs to the delivery host).
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
}

export interface RecipientSendParams {
  from: string;
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  emailId?: string;
  domain: string;
  extraHeaders: Record<string, string>;
}

export interface RecipientSendResult {
  recipient: string;
  providerMessageId: string;
  ok: boolean;
  errorCode?: number;
  errorMessage?: string;
}

export async function sendToRecipient(
  transport: Transporter,
  params: RecipientSendParams
): Promise<RecipientSendResult> {
  const providerMessageId = `<${Date.now()}.${randomUUID()}@${params.domain}>`;

  const headers: Record<string, string> = { ...params.extraHeaders };
  if (params.emailId) {
    // Carries the v:email-id correlation value through as a header the
    // delivery host's MTA logs, per doc 13 §2.4 — the shim's own event
    // store also keys on it directly (see routes/messages.ts), so this is
    // belt-and-braces for anything reading raw MTA logs later.
    headers['X-Ghost-Email-Id'] = params.emailId;
  }

  try {
    await transport.sendMail({
      messageId: providerMessageId,
      from: params.from,
      to: params.toName ? { name: params.toName, address: params.to } : params.to,
      replyTo: params.replyTo,
      subject: params.subject,
      html: params.html,
      text: params.text,
      headers,
    });
    return { recipient: params.to, providerMessageId, ok: true };
  } catch (error) {
    const err = error as Error & { responseCode?: number };
    return {
      recipient: params.to,
      providerMessageId,
      ok: false,
      errorCode: err.responseCode,
      errorMessage: err.message?.slice(0, 2000),
    };
  }
}

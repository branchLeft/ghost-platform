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

// nodemailer hands a bare `to` string through its RFC 2822 address-list
// parser: a colon or semicolon opens group syntax and a comma separates
// addresses, so any of those characters let the envelope recipient nodemailer
// actually sends to differ from the address this shim intended — e.g.
// "grp:attacker@evil.com;" resolves to the envelope recipient
// "attacker@evil.com" (verified via nodemailer's streamTransport). A plain
// email address never contains them, so reject anything that does rather
// than let the address grammar reinterpret it.
const UNSAFE_RECIPIENT_CHARS = /[\r\n\t,;:<>"]/;

export function isSafeRecipientAddress(address: string): boolean {
  if (!address || UNSAFE_RECIPIENT_CHARS.test(address)) {
    return false;
  }
  const at = address.indexOf('@');
  return at > 0 && at === address.lastIndexOf('@') && at < address.length - 1;
}

export async function sendToRecipient(
  transport: Transporter,
  params: RecipientSendParams
): Promise<RecipientSendResult> {
  const providerMessageId = `<${Date.now()}.${randomUUID()}@${params.domain}>`;

  if (!isSafeRecipientAddress(params.to)) {
    return {
      recipient: params.to,
      providerMessageId,
      ok: false,
      errorMessage: 'Invalid recipient address',
    };
  }

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

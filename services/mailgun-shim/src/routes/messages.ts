import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { requireTenantForDomain } from '../auth.js';
import { mapWithConcurrency } from '../concurrency.js';
import { parseMailgunMessageFields, resolveRecipientTokens } from '../mailgunFields.js';
import { sendToRecipient, type Transporter } from '../smtp.js';
import type { ShimStore, SuppressionType } from '../store.js';
import { SUPPRESSION_TYPES } from '../store.js';

const RECIPIENT_SEND_CONCURRENCY = 5;

/**
 * Options fields ('o:*') map to Mailgun boolean-shaped values of "yes"/"no"
 * (mailgun-client.js's prepareBooleanValues, verified against the real
 * mailgun.js client — see the messages.create() bundle source) — we only
 * read the ones this shim's send path can act on.
 */
function isYes(value: string | string[] | undefined): boolean {
  return (Array.isArray(value) ? value[0] : value) === 'yes';
}

async function deliverMessageAsync(
  store: ShimStore,
  transport: Transporter,
  domain: string,
  fields: Awaited<ReturnType<typeof parseMailgunMessageFields>>,
  emailId: string | undefined
): Promise<void> {
  const suppressedByRecipient = new Map<string, SuppressionType>();
  for (const recipient of fields.to) {
    for (const type of SUPPRESSION_TYPES) {
      if (store.isSuppressed(domain, type, recipient)) {
        suppressedByRecipient.set(recipient, type);
        break;
      }
    }
  }

  const deliverable = fields.to.filter((recipient) => !suppressedByRecipient.has(recipient));

  await mapWithConcurrency(deliverable, RECIPIENT_SEND_CONCURRENCY, async (recipient) => {
    const vars = fields.recipientVariables[recipient] ?? {};
    const resolvedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields.headers)) {
      if (name === 'Reply-To' || name === 'Sender') {
        continue;
      }
      resolvedHeaders[name] = resolveRecipientTokens(value, vars);
    }

    const result = await sendToRecipient(transport, {
      from: fields.from,
      to: recipient,
      toName: vars.name,
      subject: resolveRecipientTokens(fields.subject, vars),
      html: resolveRecipientTokens(fields.html, vars),
      text: resolveRecipientTokens(fields.text, vars),
      replyTo: fields.headers['Reply-To'],
      emailId,
      domain,
      extraHeaders: resolvedHeaders,
    });

    // This records SMTP-accepted-for-relay as "delivered", which is a
    // thinner signal than a real bounce/complaint — doc 13 §2.4 point 3
    // names this trade-off explicitly rather than pretending it isn't
    // there. Real delivery/bounce signal is the DSN-ingestion follow-up
    // this interface deliberately doesn't preclude.
    store.recordEvent({
      domain,
      type: result.ok ? 'delivered' : 'failed',
      severity: result.ok ? null : 'permanent',
      recipient,
      emailId: emailId ?? null,
      providerMessageId: result.providerMessageId,
      timestamp: Date.now() / 1000,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
    });
  });
}

export function createMessagesRouter(store: ShimStore, transport: Transporter): Router {
  const router = createRouter();

  router.post(
    '/v3/:domain/messages',
    requireTenantForDomain(store),
    async (req: Request, res: Response) => {
      const domain = req.params.domain as string;

      let fields;
      try {
        fields = await parseMailgunMessageFields(req);
      } catch {
        res.status(400).json({ message: 'Failed to parse request' });
        return;
      }

      if (fields.to.length === 0) {
        res.status(400).json({ message: 'No recipients' });
        return;
      }

      const emailId = fields.customVars['email-id'];
      const trackOpens = isYes(fields.options['tracking-opens']);
      void trackOpens; // open tracking has no receiving pixel in this skeleton; accepted but not yet acted on.

      const batchId = `<${Date.now()}.${randomUUID()}@${domain}>`;

      // Enqueue and return immediately — Ghost's request must not stay open
      // for a 1,000-recipient SMTP fan-out (doc 13 §2.4 point 1). Fire-and
      // forget here is a walking-skeleton simplification: a container
      // recycle mid-send loses whatever hasn't been submitted yet. A real
      // deployment needs a durable queue (Cloud Tasks, or a DB-backed retry
      // table) so an in-flight batch survives that — this shim's interface
      // doesn't preclude adding one, but it isn't one yet.
      deliverMessageAsync(store, transport, domain, fields, emailId).catch((err: unknown) => {
        console.error('mailgun-shim: async delivery failed', err);
      });

      res.status(200).json({ id: batchId, message: 'Queued. Thank you.' });
    }
  );

  return router;
}

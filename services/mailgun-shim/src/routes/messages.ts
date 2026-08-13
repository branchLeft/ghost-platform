import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { requireTenantForDomain } from '../auth.js';
import type { Logger } from '../log.js';
import { parseMailgunMessageFields } from '../mailgunFields.js';
import { tenantRateLimiter } from '../rateLimit.js';
import type { ShimStore } from '../store.js';
import type { WorkerHandle } from '../worker.js';

/**
 * Options fields ('o:*') map to Mailgun boolean-shaped values of "yes"/"no"
 * (mailgun-client.js's prepareBooleanValues, verified against the real
 * mailgun.js client — see the messages.create() bundle source) — we only
 * read the ones this shim's send path can act on.
 */
function isYes(value: string | string[] | undefined): boolean {
  return (Array.isArray(value) ? value[0] : value) === 'yes';
}

/**
 * Real Mailgun tolerates a recipient listed twice in one send. Dedup is
 * exact-string (case-sensitive): the local part of an address is
 * case-sensitive per RFC 5321, so "A@x.com" and "a@x.com" are kept as
 * distinct recipients rather than silently merged. This also protects the
 * queue's (batch_id, recipient) primary key — without it, a duplicate
 * recipient reaches store.enqueueBatch and throws.
 */
function dedupeRecipients(recipients: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const recipient of recipients) {
    if (!seen.has(recipient)) {
      seen.add(recipient);
      deduped.push(recipient);
    }
  }
  return deduped;
}

export function createMessagesRouter(store: ShimStore, worker: WorkerHandle, log: Logger): Router {
  const router = createRouter();

  router.post(
    '/v3/:domain/messages',
    tenantRateLimiter(60),
    requireTenantForDomain(store),
    asyncHandler(log, async (req: Request, res: Response) => {
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

      const recipients = dedupeRecipients(fields.to);

      const emailId = fields.customVars['email-id'] ?? null;
      const trackOpens = isYes(fields.options['tracking-opens']);
      void trackOpens; // open tracking has no receiving pixel in this skeleton; accepted but not yet acted on.

      const batchId = `<${Date.now()}.${randomUUID()}@${domain}>`;

      // Enqueue durably and return immediately — Ghost's request must not
      // stay open for a 1,000-recipient SMTP fan-out (doc 13 §2.4 point 1).
      // Every recipient row is written in the same transaction as the
      // batch row, so a crash right after this responds 200 leaves nothing
      // half-written for the worker's startup drain to pick up incorrectly.
      store.enqueueBatch({
        batchId,
        domain,
        emailId,
        payload: {
          from: fields.from,
          subject: fields.subject,
          html: fields.html,
          text: fields.text,
          headers: fields.headers,
          recipientVariables: fields.recipientVariables,
        },
        recipients,
        now: Date.now() / 1000,
      });

      log.info('enqueue', { domain, batchId, recipientCount: recipients.length });
      worker.kick();

      res.status(200).json({ id: batchId, message: 'Queued. Thank you.' });
    })
  );

  return router;
}

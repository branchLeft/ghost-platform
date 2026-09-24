import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { requireTenantForDomain } from '../auth.js';
import type { Logger } from '../log.js';
import { parseMailgunMessageFields } from '../mailgunFields.js';
import { tenantRateLimiter } from '../rateLimit.js';
import { senderBelongsToTenant } from '../senderAuthorization.js';
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
 * Case-insensitive lookup into the `h:*`-derived headers map. Mailgun's
 * wire shape carries a header's name as a literal multipart field name
 * (`h:Reply-To`, `h:Sender`) rather than as a real MIME header, so nothing
 * upstream of this shim normalises its case — a caller free to spell it
 * `h:reply-to` must not slip past a check keyed on the exact casing every
 * other caller happens to use.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
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

      // A tenant credential may only send as its own domain — mx1's
      // mustMatchSender binds the envelope to the shim's own relaying
      // login once mail leaves this process, never to the tenant that
      // submitted a given send, so this intake is the only hop that can
      // still tell tenants apart. A real Mailgun 400 for "not a valid
      // address" is the shape this mirrors — permanent, not one of the
      // codes worth an automatic retry.
      if (!senderBelongsToTenant(fields.from, domain)) {
        res.status(400).json({ message: `'from' address must belong to the domain ${domain}` });
        return;
      }
      // A Reply-To header changes what the recipient sees as the reply
      // address, and worker.ts's own send path DOES forward it (as
      // nodemailer's `replyTo` option) even though it drops a raw h:Reply-To
      // header from the extra-headers map — so this is a real, live
      // visible-sender surface, not a defensive-only one. A Sender header
      // is dropped everywhere downstream today and reaches no recipient,
      // but is refused here too: defence in depth against that changing
      // silently, and it is the exact header MTAs treat as the
      // responsible-submitter override when a From is a mailing-list address.
      const replyTo = findHeader(fields.headers, 'Reply-To');
      if (replyTo !== undefined && !senderBelongsToTenant(replyTo, domain)) {
        res
          .status(400)
          .json({ message: `'h:Reply-To' address must belong to the domain ${domain}` });
        return;
      }
      const senderHeader = findHeader(fields.headers, 'Sender');
      if (senderHeader !== undefined && !senderBelongsToTenant(senderHeader, domain)) {
        res.status(400).json({ message: `'h:Sender' address must belong to the domain ${domain}` });
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

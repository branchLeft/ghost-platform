import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { requireTenantForDomain } from '../auth.js';
import type { Logger } from '../log.js';
import { parseMailgunMessageFields } from '../mailgunFields.js';
import { tenantRateLimiter } from '../rateLimit.js';
import { resolveSenderDomain, senderBelongsToTenant } from '../senderAuthorization.js';
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

      const tenant = res.locals.tenant;
      /* v8 ignore start -- proven unreachable: requireTenantForDomain
       * (auth.ts) runs before this handler on every route that reaches
       * here and only calls next() once it has set res.locals.tenant.
       * Kept as a fail-closed guard against that contract changing. */
      if (!tenant) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      /* v8 ignore stop */

      // The fail-closed gate: a tenant with no registered sender domain
      // (every row that predates this field) is refused rather than
      // silently checked against its credential key — see
      // resolveSenderDomain's own doc comment for why that fallback is
      // exactly the bug this exists to prevent.
      const senderDomain = resolveSenderDomain(tenant, log, 'http');
      if (!senderDomain) {
        res
          .status(500)
          .json({ message: 'Sender domain not registered for this tenant; contact the operator.' });
        return;
      }

      // A tenant credential may only send as its own registered sender
      // domain — mx1's mustMatchSender binds the envelope to the shim's own
      // relaying login once mail leaves this process, never to the tenant
      // that submitted a given send, so this intake is the only hop that
      // can still tell tenants apart. A real Mailgun 400 for "not a valid
      // address" is the shape this mirrors — permanent, not one of the
      // codes worth an automatic retry.
      if (!senderBelongsToTenant(fields.from, senderDomain)) {
        res
          .status(400)
          .json({ message: `'from' address must belong to the domain ${senderDomain}` });
        return;
      }
      // Reply-To is deliberately NOT checked here — it names where a
      // reply goes, not who sent the mail, and Ghost lets admins set any
      // newsletter reply-to freely (email-address-service.ts's validate()
      // allows it self-hosted). Refusing a foreign one would refuse
      // legitimate mail: only From and the envelope sender identify the
      // sender.
      //
      // Sender is never taken from the tenant; From is the checked
      // identity. There is no Sender check here because there is nothing
      // left to check: parseMailgunMessageFields (mailgunFields.ts) drops
      // every h:* key that nodemailer's own normalisation would fold into
      // 'Sender' before it ever reaches `fields.headers`, on any spelling —
      // matching, foreign, duplicated, padded, differently cased. Ghost's
      // own request always carries a canonical `h:Sender` equal to its own
      // From (mailgun-client.js:65,71, forks/Ghost tag v6.55.0), so nothing
      // legitimate is lost by dropping it unconditionally rather than
      // validating a value that would only ever restate the check above.

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

import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
// nodemailer's own header-key normalisation, not reimplemented. The h:Sender
// check below must refuse exactly the set of h:* keys nodemailer will later
// treat as a Sender line once it builds the outgoing message (worker.ts's
// extraHeaders reach nodemailer's mail-composer via addHeader, which keys
// each custom header by this same normalisation before appending it) —
// verified against the installed package
// (nodemailer/lib/mime-node/index.js, MimeNode.prototype._normalizeHeaderKey:
// strips control characters, trims, then lower/upper-cases into
// nodemailer's canonical form; 'sender', 'SENDER', ' Sender' and 'Sender '
// all normalise to 'Sender'). The method reads only its `key` argument, so
// calling it straight off the prototype needs no MimeNode instance.
// `@types/nodemailer`'s own .d.ts for this path declares the public shape
// only — `_normalizeHeaderKey` is private/undocumented — so it is reached
// through a narrow local cast rather than a `declare module` augmentation,
// which would have to redeclare (and could drift from) that published type.
import MimeNode from 'nodemailer/lib/mime-node/index.js';
import { asyncHandler } from '../asyncHandler.js';
import { requireTenantForDomain } from '../auth.js';
import type { Logger } from '../log.js';
import { parseMailgunMessageFields } from '../mailgunFields.js';
import { tenantRateLimiter } from '../rateLimit.js';
import { resolveSenderDomain, senderBelongsToTenant } from '../senderAuthorization.js';
import type { ShimStore } from '../store.js';
import type { WorkerHandle } from '../worker.js';

interface MimeNodePrototypeWithNormalizer {
  _normalizeHeaderKey(key: string): string;
}

/** See the import comment above — this is nodemailer's real normalisation, not a reimplementation. */
function normalizeMailHeaderKey(key: string): string {
  return (MimeNode.prototype as unknown as MimeNodePrototypeWithNormalizer)._normalizeHeaderKey(
    key
  );
}

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
 * Every value of every `h:*` key whose nodemailer-normalised name is
 * 'Sender' — never just the first case-insensitive match. Mailgun's wire
 * shape carries each header as its own literal multipart field name
 * (`h:Sender`, `h:sender`, `h:Sender ` with a trailing space are three
 * distinct field names, hence three distinct keys in the parsed `headers`
 * map), and worker.ts forwards every one of them nodemailer's own
 * `addHeader` doesn't drop straight through to the outgoing message —
 * `addHeader` APPENDS rather than replaces, so a submission carrying more
 * than one key that nodemailer will treat as Sender reaches the recipient
 * with as many Sender lines as it sent. A check keyed on a single naive
 * case-insensitive match (or on nodemailer's normalisation but stopping at
 * the first hit) leaves every OTHER such key completely unchecked; this
 * returns all of them so the caller can refuse the request if any one
 * fails to belong to the tenant.
 */
function findAllSenderHeaderValues(headers: Record<string, string>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (normalizeMailHeaderKey(key) === 'Sender') {
      values.push(value);
    }
  }
  return values;
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
      // A Sender header is NOT dropped everywhere downstream — that was
      // true only for Ghost's own canonical request shape, and only by
      // accident of a different mechanism: worker.ts strips exactly one
      // literal key, `'Sender'` (case-sensitive, unpadded), before handing
      // headers to nodemailer, and Ghost always spells it that way. Every
      // other spelling of the same logical header — `sender`, `SENDER`,
      // `' Sender'`, `'Sender '` — is NOT stripped there: nodemailer's
      // `addHeader` (mail-composer.js) appends it as a real custom header,
      // and this shim never sets the root `sender` field that would
      // otherwise override it (verified against the installed nodemailer
      // package with both a foreign and a from-matching Sender value —
      // nodemailer relays both; it does not omit an equal-to-From Sender
      // either). So this is the only place a foreign Sender is ever
      // stopped, and it has to catch every h:* key nodemailer will
      // normalise to Sender, not just one spelling of it — it is the exact
      // header MTAs treat as the responsible-submitter override for a From
      // that is a mailing-list address.
      for (const senderHeader of findAllSenderHeaderValues(fields.headers)) {
        if (!senderBelongsToTenant(senderHeader, senderDomain)) {
          res
            .status(400)
            .json({ message: `'h:Sender' address must belong to the domain ${senderDomain}` });
          return;
        }
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

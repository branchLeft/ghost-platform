import { randomBytes } from 'node:crypto';

/**
 * The export colour is a second Ghost process on the tenant's live
 * database, booted with the tenant's own environment. On its own, Ghost 6.55
 * would, from that process:
 *
 * - send transactional and bulk mail through the tenant's real transports;
 * - reschedule every scheduled post and newsletter on boot, and publish or
 *   send each when due;
 * - start the email-analytics and click-tracking recurring jobs;
 * - check for updates;
 * - reconcile the tenant's Stripe webhook against its own URL.
 *
 * These overrides turn each of those off, by the settings Ghost reads for
 * them. Every existing key under a switched-off prefix is dropped first, so
 * nothing of the tenant's own mail or scheduler config survives alongside
 * the override.
 */

/** Ghost's own stub transport: accepts a message and sends it nowhere. */
export const MAIL_TRANSPORT = 'stub';
/**
 * Configured bulk email takes precedence over the Mailgun settings in the
 * database, so a sink here is what stops those settings being used. Port 9
 * on the container's own loopback has no listener: every call is refused.
 */
export const BULK_EMAIL_SINK = 'http://127.0.0.1:9/v3';
/** The no-op adapter the platform image ships (ghost-adapter/). */
export const SCHEDULING_ADAPTER = 'SchedulingDisabled';

const DROPPED_PREFIXES = ['mail__', 'bulkEmail__', 'adapters__scheduling__', 'updateCheck__'];

/**
 * `webhookSecret` puts Ghost's Stripe webhook manager into local mode, so it
 * never creates, deletes or re-points the tenant's Stripe webhook. Nothing
 * can reach the export colour to use the secret: it is published on
 * loopback only.
 */
export function exportColourOverrides(webhookSecret: string): Readonly<Record<string, string>> {
  return {
    mail__transport: MAIL_TRANSPORT,
    bulkEmail__mailgun__baseUrl: BULK_EMAIL_SINK,
    bulkEmail__mailgun__apiKey: 'export-colour-sends-nothing',
    bulkEmail__mailgun__domain: 'export-colour.invalid',
    adapters__scheduling__active: SCHEDULING_ADAPTER,
    backgroundJobs__emailAnalytics: 'false',
    backgroundJobs__clickTrackingLastSeenAtUpdater: 'false',
    privacy__useUpdateCheck: 'false',
    WEBHOOK_SECRET: webhookSecret,
  };
}

export function isolateExportColour(
  tenantEnv: Readonly<Record<string, string>>,
  webhookSecret: string = randomBytes(32).toString('hex')
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(tenantEnv)) {
    if (DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return { ...env, ...exportColourOverrides(webhookSecret) };
}

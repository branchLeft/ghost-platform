import { sql, type SQL } from 'drizzle-orm';
import { queueBatches } from './schema.js';

/**
 * `transactional` is mail a member is waiting on (sign-in links); `bulk` is a
 * newsletter. Same two names the mail collector uses.
 */
export type MailClass = 'transactional' | 'bulk';

/**
 * The one rule that decides a queued message's class, and it is the mail
 * collector's own rule (`mailClassOf` in services/mail-collector): only a
 * non-empty email id names a campaign. A null or empty id is sign-in mail,
 * which is also why the shim writes no X-Ghost-Email-Id header for it. The
 * SMTP front door always enqueues a null id, so mail submitted over SMTP can
 * never be bulk.
 */
export function mailClassOf(emailId: string | null | undefined): MailClass {
  return typeof emailId === 'string' && emailId !== '' ? 'bulk' : 'transactional';
}

/**
 * The same rule as a SQL sort key for `claimForDrain`: 0 for transactional,
 * 1 for bulk, so transactional rows sort first. Kept next to `mailClassOf`,
 * and a test asks both of every case so they cannot drift apart.
 */
export const MAIL_CLASS_RANK: SQL = sql`CASE WHEN ${queueBatches.emailId} IS NULL OR ${queueBatches.emailId} = '' THEN 0 ELSE 1 END`;

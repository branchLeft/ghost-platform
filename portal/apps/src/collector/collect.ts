import {
  SUPPORT_READING_FRESH_SECONDS,
  type SupportAccessReading,
} from 'ghost-platform-portal-data/owner';
import { parseSupportAccessScrape } from './supportScrape.js';

/** The two things the collector needs of the owner's database layer. */
export interface SupportAccessSink {
  listTenantSlugs(): Promise<Array<{ slug: string; tenantId: string }>>;
  recordSupportAccess(
    tenantId: string,
    reading: SupportAccessReading,
    observedAt: Date
  ): Promise<void>;
}

/** Why a tenant's reading was not written, as the run log says it. */
export type LeftOut = 'unknown-tenant' | 'old' | 'future';

export interface CollectSummary {
  /** False when the whole scrape was refused: nothing in it was used. */
  readonly accepted: boolean;
  readonly recorded: number;
  readonly leftOut: number;
  /** A write the database refused or could not make. */
  readonly failed: number;
}

export interface CollectInput {
  readonly sink: SupportAccessSink;
  /** The text one host's exporter answered with. */
  readonly scrape: string;
  readonly now: Date;
  /** One line per tenant and one for the run; never the scrape and never a reason or a grant. */
  readonly log: (line: string) => void;
}

/**
 * Writes what one host's exporter says about each of its tenants into the
 * portal, and nothing it does not say. The collector only ever adds a reading
 * the host gave; it has no way to say `closed` for a tenant the host did not
 * report, because silence is how the page learns `unknown`. A reading is left
 * out when its tenant is not registered, when the host's own time on it is more
 * than `SUPPORT_READING_FRESH_SECONDS` before or after now, or when the series
 * for it break the contract.
 */
export async function collectSupportAccess(input: CollectInput): Promise<CollectSummary> {
  const parsed = parseSupportAccessScrape(input.scrape);
  if (parsed.kind === 'refused') {
    input.log('support-access: the exporter text is not the contract; nothing written');
    return { accepted: false, recorded: 0, leftOut: 0, failed: 0 };
  }

  const tenants = new Map((await input.sink.listTenantSlugs()).map((t) => [t.slug, t.tenantId]));
  const limitMs = SUPPORT_READING_FRESH_SECONDS * 1000;
  let recorded = 0;
  let leftOut = parsed.left;
  let failed = 0;
  const left = (slug: string, why: LeftOut): void => {
    leftOut += 1;
    input.log(`support-access: ${slug}: left out: ${why}`);
  };
  if (parsed.left > 0) input.log(`support-access: ${parsed.left} tenant(s) left out: unreadable`);

  for (const { slug, reading, observedAt } of parsed.readings) {
    const tenantId = tenants.get(slug);
    if (tenantId === undefined) {
      left(slug, 'unknown-tenant');
      continue;
    }
    const ageMs = input.now.getTime() - observedAt.getTime();
    if (ageMs > limitMs) {
      left(slug, 'old');
      continue;
    }
    if (ageMs < -limitMs) {
      left(slug, 'future');
      continue;
    }
    try {
      await input.sink.recordSupportAccess(tenantId, reading, observedAt);
    } catch {
      failed += 1;
      input.log(`support-access: ${slug}: write failed`);
      continue;
    }
    recorded += 1;
    input.log(`support-access: ${slug}: recorded state=${reading.state}`);
  }
  input.log(`support-access: run done: recorded=${recorded} left_out=${leftOut} failed=${failed}`);
  return { accepted: true, recorded, leftOut, failed };
}

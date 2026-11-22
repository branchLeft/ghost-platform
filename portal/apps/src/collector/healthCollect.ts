import { MalformedScrapeError } from 'ghost-platform-portal-data/owner';
import { parseHealthReport } from './healthReport.js';

/** The two things the health collector needs of the owner's database layer. */
export interface HealthSink {
  listTenantSlugs(): Promise<Array<{ slug: string; tenantId: string }>>;
  recordReading(tenantId: string, scrapes: readonly string[], observedAt: Date): Promise<void>;
}

export interface HealthSummary {
  /** False when the whole report was refused: nothing in it was used. */
  readonly accepted: boolean;
  /** Readings written, an `unknown` one included. */
  readonly recorded: number;
  /** Of those, how many were written as `unknown` because a colour was not read or not readable. */
  readonly unknown: number;
  /** Tenants named by the report that are not registered. */
  readonly leftOut: number;
  /** A write the database refused or could not make. */
  readonly failed: number;
}

export interface HealthInput {
  readonly sink: HealthSink;
  /** The report text the native program sent. */
  readonly report: string;
  readonly now: Date;
  /** One line per tenant and one for the run; never the report, a scrape or an id. */
  readonly log: (line: string) => void;
}

/**
 * Writes one reading for each tenant the report names. A reading is only ever
 * as good as everything that went into it: when any colour of a tenant was not
 * read, or its text is not the sidecar's, the reading written is `unknown`
 * (no scrape at all), never the one colour that did answer. A tenant that
 * answers `unknown` is the one outcome the portal cannot mistake for health,
 * and writing it replaces the earlier reading, so a tenant that has stopped
 * answering cannot keep showing the last good one. The mismatch date is not
 * touched by an `unknown` reading (`OwnerDb.recordReading`).
 *
 * A tenant the report does not name is not written: this run has no word on it.
 */
export async function collectHealth(input: HealthInput): Promise<HealthSummary> {
  const parsed = parseHealthReport(input.report);
  if (parsed.kind === 'refused') {
    input.log('health: the report is not the contract; nothing written');
    return { accepted: false, recorded: 0, unknown: 0, leftOut: 0, failed: 0 };
  }

  const tenants = new Map((await input.sink.listTenantSlugs()).map((t) => [t.slug, t.tenantId]));
  let recorded = 0;
  let unknown = 0;
  let leftOut = 0;
  let failed = 0;

  for (const { slug, scrapes } of parsed.tenants) {
    const tenantId = tenants.get(slug);
    if (tenantId === undefined) {
      leftOut += 1;
      input.log(`health: ${slug}: left out: unknown-tenant`);
      continue;
    }
    const texts = scrapes.filter((s): s is string => s !== null);
    const allRead = texts.length === scrapes.length;
    try {
      let outcome = 'read';
      if (!allRead) {
        await input.sink.recordReading(tenantId, [], input.now);
        outcome = 'unknown: a colour was not read';
      } else {
        try {
          await input.sink.recordReading(tenantId, texts, input.now);
        } catch (error) {
          // Refused before any write: the text is not the sidecar's.
          if (!(error instanceof MalformedScrapeError)) throw error;
          await input.sink.recordReading(tenantId, [], input.now);
          outcome = 'unknown: a colour was not readable';
        }
      }
      recorded += 1;
      if (outcome !== 'read') unknown += 1;
      input.log(`health: ${slug}: recorded ${outcome}`);
    } catch {
      failed += 1;
      input.log(`health: ${slug}: write failed`);
    }
  }
  input.log(
    `health: run done: recorded=${recorded} unknown=${unknown} left_out=${leftOut} failed=${failed}`
  );
  return { accepted: true, recorded, unknown, leftOut, failed };
}

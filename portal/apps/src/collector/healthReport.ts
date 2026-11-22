/**
 * What the native program on ops1 hands the health collector, on standard
 * input, once per run: for each tenant it was told to read, the text each
 * colour's drain sidecar answered `GET /metrics` with, or `null` where a
 * colour could not be read.
 *
 *   {"tenants":[{"tenant":"<slug>","scrapes":["<text>", null]}]}
 *
 * A sidecar's text carries no tenant name (the sidecar does not know one), so
 * the slug here is the host program's own configuration, not something a host
 * said about itself. Anything that is not exactly this shape refuses the whole
 * report: nothing is written from a report that cannot be trusted whole.
 */

/** The same shape the tenant name has (`TENANT_NAME_PATTERN`): a slug and nothing else. */
const SLUG = /^[a-z][a-z0-9-]{1,24}[a-z0-9]$/;

/** A tenant has two colours, a and b, and no more. */
export const MAX_COLOURS = 2;
/** A sidecar's text is a dozen short lines; more than this is not one. */
export const MAX_SCRAPE_CHARS = 16 * 1024;
export const MAX_TENANTS = 500;

export interface ReportedTenant {
  readonly slug: string;
  /** One entry per colour the program was told to read; null where that colour was not read. */
  readonly scrapes: ReadonlyArray<string | null>;
}

export type ReportOutcome =
  | { readonly kind: 'read'; readonly tenants: readonly ReportedTenant[] }
  | { readonly kind: 'refused' };

const REFUSED: ReportOutcome = { kind: 'refused' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** The tenants in one report, or `refused` when it is not the contract. */
export function parseHealthReport(text: string): ReportOutcome {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return REFUSED;
  }
  if (!isRecord(document) || !hasOnly(document, ['tenants'])) return REFUSED;
  const list = document['tenants'];
  if (!Array.isArray(list) || list.length > MAX_TENANTS) return REFUSED;

  const seen = new Set<string>();
  const tenants: ReportedTenant[] = [];
  for (const entry of list as unknown[]) {
    if (!isRecord(entry) || !hasOnly(entry, ['tenant', 'scrapes'])) return REFUSED;
    const slug = entry['tenant'];
    const scrapes = entry['scrapes'];
    if (typeof slug !== 'string' || !SLUG.test(slug) || seen.has(slug)) return REFUSED;
    if (!Array.isArray(scrapes) || scrapes.length < 1 || scrapes.length > MAX_COLOURS) {
      return REFUSED;
    }
    for (const scrape of scrapes as unknown[]) {
      if (scrape === null) continue;
      if (typeof scrape !== 'string' || scrape.length > MAX_SCRAPE_CHARS) return REFUSED;
    }
    seen.add(slug);
    tenants.push({ slug, scrapes: scrapes as Array<string | null> });
  }
  return { kind: 'read', tenants };
}

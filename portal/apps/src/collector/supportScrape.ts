import type { SupportAccessReading } from 'ghost-platform-portal-data/owner';

/**
 * Reads one host's support-access textfile, as node_exporter serves it, into one
 * reading per tenant. The series are the contract the host writer emits
 * (the host writer's own documentation, in `adapters/sso/scripts/host/`):
 *
 *   branchleft_support_access_state{tenant,state}            1
 *   branchleft_support_access_lane{tenant,lane}              1
 *   branchleft_support_access_granted_timestamp_seconds{tenant}
 *   branchleft_support_access_deadline_timestamp_seconds{tenant}
 *   branchleft_support_access_observed_timestamp_seconds{tenant}
 *
 * Anything else in the text is not ours and is ignored. Anything that is ours
 * and wrong is never repaired: a line that carries one of the five names but
 * is not in its shape refuses the whole scrape, and a tenant whose own series
 * contradict the contract is left out. A tenant that is left out has no
 * reading, which the portal shows as "unknown"; it is never filled in.
 */

const STATE = 'branchleft_support_access_state';
const LANE = 'branchleft_support_access_lane';
const GRANTED = 'branchleft_support_access_granted_timestamp_seconds';
const DEADLINE = 'branchleft_support_access_deadline_timestamp_seconds';
const OBSERVED = 'branchleft_support_access_observed_timestamp_seconds';

const STATES: readonly string[] = ['open', 'closed', 'unknown'];
const LANES: readonly string[] = ['consented', 'incident'];

/** The same shape the tenant name has (`TENANT_NAME_PATTERN`): a slug and nothing else. */
const SLUG = /^[a-z][a-z0-9-]{1,24}[a-z0-9]$/;
const SAMPLE = /^([A-Za-z_:][A-Za-z0-9_:]*)\{([^{}]*)\}[ \t]+(\S+)(?:[ \t]+-?[0-9]+)?[ \t]*$/;
const LABEL = /^([A-Za-z_][A-Za-z0-9_]*)="([^"\\]*)"$/;
// node_exporter serves a gauge in Go's shortest form, so a time arrives as 1.7631e+09.
const NUMBER = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** What a scrape of one host came to. */
export type ScrapeOutcome =
  | { readonly kind: 'read'; readonly readings: readonly ScrapedReading[]; readonly left: number }
  | { readonly kind: 'refused' };

export interface ScrapedReading {
  readonly slug: string;
  readonly reading: SupportAccessReading;
  /** The host's own time when its report ran. */
  readonly observedAt: Date;
}

interface Series {
  readonly name: string;
  readonly labels: ReadonlyMap<string, string>;
  readonly value: string;
}

interface Collected {
  state: string[];
  lane: string[];
  granted: string[];
  deadline: string[];
  observed: string[];
  broken: boolean;
}

const ours = (name: string): boolean =>
  name === STATE || name === LANE || name === GRANTED || name === DEADLINE || name === OBSERVED;

function parseLabels(text: string): ReadonlyMap<string, string> | null {
  const labels = new Map<string, string>();
  if (text.trim() === '') return labels;
  for (const part of text.split(',')) {
    const found = LABEL.exec(part.trim());
    if (found === null) return null;
    const [, key, value] = found;
    if (key === undefined || value === undefined || labels.has(key)) return null;
    labels.set(key, value);
  }
  return labels;
}

/** Null for a comment, a blank line or a series that is not ours; undefined for one of ours that is malformed. */
function parseLine(line: string): Series | null | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const found = SAMPLE.exec(trimmed);
  if (found === null) {
    // A line that names one of our series but is not a sample cannot be trusted
    // to leave the others alone.
    const name = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(trimmed)?.[0];
    return name !== undefined && ours(name) ? undefined : null;
  }
  const [, name, rawLabels, value] = found;
  if (name === undefined || rawLabels === undefined || value === undefined) return undefined;
  if (!ours(name)) return null;
  const labels = parseLabels(rawLabels);
  return labels === null ? undefined : { name, labels, value };
}

function seconds(value: string): Date | null {
  if (!NUMBER.test(value)) return null;
  const date = new Date(Math.round(Number(value) * 1000));
  return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? null : date;
}

/** The labels of a series are exactly `tenant` and the named extras, with a slug for the tenant. */
function tenantOf(series: Series, extra: string | null): string | null {
  const expected = extra === null ? 1 : 2;
  if (series.labels.size !== expected) return null;
  const tenant = series.labels.get('tenant');
  if (tenant === undefined || !SLUG.test(tenant)) return null;
  if (extra !== null && !series.labels.has(extra)) return null;
  return tenant;
}

function build(collected: Collected): ScrapedReading | null {
  if (collected.broken) return null;
  const [state, ...otherStates] = collected.state;
  const [observedText, ...otherObserved] = collected.observed;
  if (state === undefined || otherStates.length > 0) return null;
  if (observedText === undefined || otherObserved.length > 0) return null;
  if (!STATES.includes(state)) return null;
  if (collected.lane.length > 1 || collected.granted.length > 1 || collected.deadline.length > 1) {
    return null;
  }
  const observedAt = seconds(observedText);
  if (observedAt === null) return null;
  const lane = collected.lane[0] ?? null;
  const grantedText = collected.granted[0] ?? null;
  const deadlineText = collected.deadline[0] ?? null;
  // Only an open account carries a lane and a clock; a closed or unknown one that
  // does is not the host writer's file, so none of it is believed.
  if (state !== 'open' && (lane !== null || grantedText !== null || deadlineText !== null)) {
    return null;
  }
  if (lane !== null && !LANES.includes(lane)) return null;
  const grantedAt = grantedText === null ? null : seconds(grantedText);
  const deadline = deadlineText === null ? null : seconds(deadlineText);
  if (
    (grantedText !== null && grantedAt === null) ||
    (deadlineText !== null && deadline === null)
  ) {
    return null;
  }
  return {
    slug: '',
    reading: {
      state: state as SupportAccessReading['state'],
      lane: lane as SupportAccessReading['lane'],
      grantedAt,
      deadline,
    },
    observedAt,
  };
}

/**
 * The readings in one host's textfile. `left` counts the tenants that named
 * series but could not be read whole; they have no reading.
 */
export function parseSupportAccessScrape(text: string): ScrapeOutcome {
  const tenants = new Map<string, Collected>();
  const of = (tenant: string): Collected => {
    const existing = tenants.get(tenant);
    if (existing !== undefined) return existing;
    const fresh: Collected = {
      state: [],
      lane: [],
      granted: [],
      deadline: [],
      observed: [],
      broken: false,
    };
    tenants.set(tenant, fresh);
    return fresh;
  };

  for (const line of text.split('\n')) {
    const series = parseLine(line);
    if (series === undefined) return { kind: 'refused' };
    if (series === null) continue;
    const extra = series.name === STATE ? 'state' : series.name === LANE ? 'lane' : null;
    const tenant = tenantOf(series, extra);
    // A series with no readable tenant label, or a label outside the list, is not
    // ours to use: it is ignored, and the tenants it did not name are untouched.
    if (tenant === null) continue;
    const collected = of(tenant);
    if (series.name === STATE || series.name === LANE) {
      if (series.value !== '1') {
        collected.broken = true;
        continue;
      }
      (series.name === STATE ? collected.state : collected.lane).push(
        series.labels.get(extra ?? '') ?? ''
      );
    } else if (series.name === GRANTED) collected.granted.push(series.value);
    else if (series.name === DEADLINE) collected.deadline.push(series.value);
    else collected.observed.push(series.value);
  }

  const readings: ScrapedReading[] = [];
  let left = 0;
  for (const [slug, collected] of tenants) {
    const built = build(collected);
    if (built === null) left += 1;
    else readings.push({ ...built, slug });
  }
  return { kind: 'read', readings, left };
}

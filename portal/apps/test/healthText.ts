import { MalformedScrapeError } from 'ghost-platform-portal-data/owner';
import type { HealthInput, HealthSink, HealthSummary } from '../src/collector/healthCollect.js';
import { collectHealth } from '../src/collector/healthCollect.js';

/** What a drain sidecar's `GET /metrics` answers, for each colour state. The versions in tests are placeholders. */
export const UNDRAINED_MATCHING = [
  '# TYPE drain_sidecar_drained gauge',
  'drain_sidecar_drained 0',
  '# TYPE drain_sidecar_ghost_version_info gauge',
  'drain_sidecar_ghost_version_info{version="6.55.0"} 1',
  '# TYPE drain_sidecar_version_match gauge',
  'drain_sidecar_version_match 1',
  '',
].join('\n');

export const UNDRAINED_MISMATCHED = UNDRAINED_MATCHING.replace(
  'drain_sidecar_version_match 1',
  'drain_sidecar_version_match 0'
);

export const DRAINED = ['# TYPE drain_sidecar_drained gauge', 'drain_sidecar_drained 1', ''].join(
  '\n'
);

export const NOT_A_SCRAPE = '<html>502 Bad Gateway</html>';

export const ONE = '92000000-0000-4000-8000-000000000001';
export const TWO = '92000000-0000-4000-8000-000000000002';
export const NOW = new Date('2026-11-20T12:00:00Z');

export type Colours = ReadonlyArray<string | null>;

/** The report the native program sends. The slugs in tests are placeholders, never a real tenant's. */
export function report(tenants: ReadonlyArray<readonly [string, Colours]>): string {
  return JSON.stringify({ tenants: tenants.map(([tenant, scrapes]) => ({ tenant, scrapes })) });
}

export interface Write {
  readonly tenantId: string;
  readonly scrapes: readonly string[];
  readonly observedAt: Date;
}

/**
 * A stand-in for the owner role that refuses a text with no drain flag the way
 * the real one does (`MalformedScrapeError`, before any write), and can refuse
 * one tenant's write as the database might.
 */
export function fakeSink(options: { failFor?: string } = {}): {
  sink: HealthSink;
  writes: Write[];
} {
  const writes: Write[] = [];
  const sink: HealthSink = {
    listTenantSlugs: () =>
      Promise.resolve([
        { slug: 'placeholder-one', tenantId: ONE },
        { slug: 'placeholder-two', tenantId: TWO },
      ]),
    recordReading: (tenantId, scrapes, observedAt) => {
      if (scrapes.some((text) => !text.includes('drain_sidecar_drained'))) {
        return Promise.reject(new MalformedScrapeError('no drain flag'));
      }
      if (options.failFor !== undefined && tenantId === options.failFor) {
        return Promise.reject(new Error('database said no'));
      }
      writes.push({ tenantId, scrapes, observedAt });
      return Promise.resolve();
    },
  };
  return { sink, writes };
}

/** Runs one collection at `NOW`; `run` is the real collector unless a sabotage test passes a broken copy. */
export async function collect(
  text: string,
  sink: HealthSink,
  run: (input: HealthInput) => Promise<HealthSummary> = collectHealth
): Promise<{ summary: HealthSummary; lines: string[] }> {
  const lines: string[] = [];
  const summary = await run({ sink, report: text, now: NOW, log: (line) => lines.push(line) });
  return { summary, lines };
}

import type { SupportAccessReading } from 'ghost-platform-portal-data/owner';
import {
  collectSupportAccess,
  type CollectInput,
  type CollectSummary,
  type SupportAccessSink,
} from '../src/collector/collect.js';

/** One tenant as the host writer's file would carry it. The slugs in tests are placeholders, never a real tenant's. */
export interface Sample {
  readonly tenant: string;
  readonly state: 'open' | 'closed' | 'unknown';
  readonly lane?: 'consented' | 'incident';
  readonly granted?: number;
  readonly deadline?: number;
  readonly observed: number;
}

/** What node_exporter serves for the host writer's file: HELP and TYPE lines, then each tenant's series. */
export function exporterText(samples: readonly Sample[]): string {
  const series = (name: string, lines: string[]): string[] => [
    `# HELP ${name} test`,
    `# TYPE ${name} gauge`,
    ...lines,
  ];
  const time = (seconds: number): string => seconds.toFixed(3);
  return [
    ...series(
      'branchleft_support_access_state',
      samples.map(
        (s) => `branchleft_support_access_state{state="${s.state}",tenant="${s.tenant}"} 1`
      )
    ),
    ...series(
      'branchleft_support_access_lane',
      samples
        .filter((s) => s.lane !== undefined)
        .map((s) => `branchleft_support_access_lane{lane="${s.lane}",tenant="${s.tenant}"} 1`)
    ),
    ...series(
      'branchleft_support_access_granted_timestamp_seconds',
      samples
        .filter((s) => s.granted !== undefined)
        .map(
          (s) =>
            `branchleft_support_access_granted_timestamp_seconds{tenant="${s.tenant}"} ${time(s.granted ?? 0)}`
        )
    ),
    ...series(
      'branchleft_support_access_deadline_timestamp_seconds',
      samples
        .filter((s) => s.deadline !== undefined)
        .map(
          (s) =>
            `branchleft_support_access_deadline_timestamp_seconds{tenant="${s.tenant}"} ${time(s.deadline ?? 0)}`
        )
    ),
    ...series(
      'branchleft_support_access_observed_timestamp_seconds',
      samples.map(
        (s) =>
          `branchleft_support_access_observed_timestamp_seconds{tenant="${s.tenant}"} ${time(s.observed)}`
      )
    ),
    '',
  ].join('\n');
}

export const ONE = '91000000-0000-4000-8000-000000000001';
export const TWO = '91000000-0000-4000-8000-000000000002';
export const NOW = new Date('2026-11-14T12:00:00Z');
export const at = (seconds: number): number => NOW.getTime() / 1000 + seconds;

export interface Write {
  readonly tenantId: string;
  readonly reading: SupportAccessReading;
  readonly observedAt: Date;
}

export function fakeSink(options: { failFor?: string } = {}): {
  sink: SupportAccessSink;
  writes: Write[];
} {
  const writes: Write[] = [];
  const sink: SupportAccessSink = {
    listTenantSlugs: () =>
      Promise.resolve([
        { slug: 'placeholder-one', tenantId: ONE },
        { slug: 'placeholder-two', tenantId: TWO },
      ]),
    recordSupportAccess: (tenantId, reading, observedAt) => {
      if (options.failFor !== undefined && tenantId === options.failFor)
        return Promise.reject(new Error('database said no'));
      writes.push({ tenantId, reading, observedAt });
      return Promise.resolve();
    },
  };
  return { sink, writes };
}

/** Runs one collection at `NOW`; `run` is the real collector unless a sabotage test passes a broken copy. */
export async function collect(
  samples: readonly Sample[] | string,
  sink: SupportAccessSink,
  run: (input: CollectInput) => Promise<CollectSummary> = collectSupportAccess
): Promise<{ summary: CollectSummary; lines: string[] }> {
  const lines: string[] = [];
  const summary = await run({
    sink,
    scrape: typeof samples === 'string' ? samples : exporterText(samples),
    now: NOW,
    log: (line) => lines.push(line),
  });
  return { summary, lines };
}

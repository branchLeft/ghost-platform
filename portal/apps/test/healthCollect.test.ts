import { describe, expect, it } from 'vitest';
import { MAX_SCRAPE_CHARS, parseHealthReport } from '../src/collector/healthReport.js';
import {
  DRAINED,
  NOT_A_SCRAPE,
  NOW,
  ONE,
  TWO,
  UNDRAINED_MATCHING,
  collect,
  fakeSink,
  report,
} from './healthText.js';

describe('the health collector writes what the sidecars said, and unknown for anything it could not read', () => {
  it('records both colours of a tenant, the drained one included, for the owner layer to choose between', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      report([['placeholder-one', [DRAINED, UNDRAINED_MATCHING]]]),
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 1, unknown: 0, leftOut: 0, failed: 0 });
    expect(writes).toEqual([
      { tenantId: ONE, scrapes: [DRAINED, UNDRAINED_MATCHING], observedAt: NOW },
    ]);
    expect(lines).toContain('health: placeholder-one: recorded read');
  });

  it('records two tenants from one report', async () => {
    const { sink, writes } = fakeSink();
    const { summary } = await collect(
      report([
        ['placeholder-one', [UNDRAINED_MATCHING]],
        ['placeholder-two', [UNDRAINED_MATCHING]],
      ]),
      sink
    );
    expect(summary.recorded).toBe(2);
    expect(writes.map((w) => w.tenantId)).toEqual([ONE, TWO]);
  });

  it('writes unknown, with no scrape at all, when one colour was not read: the colour that answered is not used alone', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      report([['placeholder-one', [UNDRAINED_MATCHING, null]]]),
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 1, unknown: 1, leftOut: 0, failed: 0 });
    expect(writes).toEqual([{ tenantId: ONE, scrapes: [], observedAt: NOW }]);
    expect(lines).toContain('health: placeholder-one: recorded unknown: a colour was not read');
  });

  it('writes unknown when the only colour was not read, so the last good reading is replaced', async () => {
    const { sink, writes } = fakeSink();
    const { summary } = await collect(report([['placeholder-one', [null]]]), sink);
    expect(summary.unknown).toBe(1);
    expect(writes).toEqual([{ tenantId: ONE, scrapes: [], observedAt: NOW }]);
  });

  it('writes unknown when a colour answered with something that is not a sidecar scrape', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      report([['placeholder-one', [NOT_A_SCRAPE, UNDRAINED_MATCHING]]]),
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 1, unknown: 1, leftOut: 0, failed: 0 });
    expect(writes).toEqual([{ tenantId: ONE, scrapes: [], observedAt: NOW }]);
    expect(lines).toContain('health: placeholder-one: recorded unknown: a colour was not readable');
  });

  it('leaves out a tenant that is not registered, and says so without a reading', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      report([['placeholder-ghost', [UNDRAINED_MATCHING]]]),
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 0, unknown: 0, leftOut: 1, failed: 0 });
    expect(writes).toEqual([]);
    expect(lines).toContain('health: placeholder-ghost: left out: unknown-tenant');
  });

  it('counts a refused write and goes on to the next tenant', async () => {
    const { sink, writes } = fakeSink({ failFor: ONE });
    const { summary, lines } = await collect(
      report([
        ['placeholder-one', [UNDRAINED_MATCHING]],
        ['placeholder-two', [UNDRAINED_MATCHING]],
      ]),
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 1, unknown: 0, leftOut: 0, failed: 1 });
    expect(writes.map((w) => w.tenantId)).toEqual([TWO]);
    expect(lines).toContain('health: placeholder-one: write failed');
  });

  it('writes nothing for an empty report', async () => {
    const { sink, writes } = fakeSink();
    const { summary } = await collect(report([]), sink);
    expect(summary).toEqual({ accepted: true, recorded: 0, unknown: 0, leftOut: 0, failed: 0 });
    expect(writes).toEqual([]);
  });

  it('never logs a scrape, a version or an id', async () => {
    const { sink } = fakeSink();
    const { lines } = await collect(
      report([['placeholder-one', [UNDRAINED_MATCHING, null]]]),
      sink
    );
    const log = lines.join('\n');
    expect(log).not.toContain('6.55.0');
    expect(log).not.toContain(ONE);
    expect(log).not.toContain('drain_sidecar');
  });
});

describe('a report that is not the contract writes nothing', () => {
  const refused = async (text: string) => {
    const { sink, writes } = fakeSink();
    const { summary } = await collect(text, sink);
    expect(summary).toEqual({ accepted: false, recorded: 0, unknown: 0, leftOut: 0, failed: 0 });
    expect(writes).toEqual([]);
  };

  it.each([
    ['text that is not JSON', 'drain_sidecar_drained 0'],
    ['a list', '[]'],
    ['no tenants key', '{}'],
    ['an extra key', '{"tenants":[],"x":1}'],
    [
      'a tenant with an extra key',
      '{"tenants":[{"tenant":"placeholder-one","scrapes":[null],"x":1}]}',
    ],
    ['a slug that is not a slug', report([['Placeholder One', [null]]])],
    [
      'a repeated slug',
      report([
        ['placeholder-one', [null]],
        ['placeholder-one', [null]],
      ]),
    ],
    ['no colours', report([['placeholder-one', []]])],
    ['three colours', report([['placeholder-one', [null, null, null]]])],
    ['a colour that is a number', '{"tenants":[{"tenant":"placeholder-one","scrapes":[1]}]}'],
    [
      'a colour that is too long',
      report([['placeholder-one', ['x'.repeat(MAX_SCRAPE_CHARS + 1)]]]),
    ],
  ])('%s', async (_name, text) => {
    await refused(text);
  });

  it('refuses the whole report when one tenant in it is bad, writing none of the others', async () => {
    const { sink, writes } = fakeSink();
    const { summary } = await collect(
      report([
        ['placeholder-one', [UNDRAINED_MATCHING]],
        ['Not A Slug', [UNDRAINED_MATCHING]],
      ]),
      sink
    );
    expect(summary.accepted).toBe(false);
    expect(writes).toEqual([]);
  });

  it('reads a report of the longest allowed colour text', () => {
    const outcome = parseHealthReport(
      report([['placeholder-one', ['x'.repeat(MAX_SCRAPE_CHARS), null]]])
    );
    expect(outcome.kind).toBe('read');
  });
});

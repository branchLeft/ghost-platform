import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectInput, CollectSummary } from '../src/collector/collect.js';
import { parseSupportAccessScrape } from '../src/collector/supportScrape.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';
import { at, collect, exporterText, fakeSink, ONE, TWO } from './collectorText.js';

interface CollectModule {
  readonly collectSupportAccess: (input: CollectInput) => Promise<CollectSummary>;
}
interface ScrapeModule {
  readonly parseSupportAccessScrape: typeof parseSupportAccessScrape;
}

const COLLECT = 'collector/collect.ts';
const SCRAPE = 'collector/supportScrape.ts';

const brokenCollect = (name: string, target: string, replacement: string): Promise<CollectModule> =>
  importSabotaged<CollectModule>(name, target, replacement, COLLECT);
const brokenScrape = (name: string, target: string, replacement: string): Promise<ScrapeModule> =>
  importSabotaged<ScrapeModule>(name, target, replacement, SCRAPE);

beforeAll(clearMutants);
afterAll(clearMutants);

const closedFor = (tenant: string, observed: number) => ({
  tenant,
  state: 'closed' as const,
  observed,
});

describe('sabotage: the collector never says closed for a host it could not read', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(brokenCollect('noop', 'text that is not in the module', 'x')).rejects.toThrow(
      'exactly once'
    );
  });

  it('RED: a collector that writes closed when the text is refused marks every tenant closed, GREEN: the real one writes nothing', async () => {
    const module = await brokenCollect(
      'closed-on-refusal',
      'return { accepted: false, recorded: 0, leftOut: 0, failed: 0 };',
      `for (const t of await input.sink.listTenantSlugs()) {
        await input.sink.recordSupportAccess(
          t.tenantId,
          { state: 'closed', lane: null, grantedAt: null, deadline: null },
          input.now
        );
      }
      return { accepted: false, recorded: 0, leftOut: 0, failed: 0 };`
    );
    const garbled = 'branchleft_support_access_state garbled\n';

    const red = fakeSink();
    await collect(garbled, red.sink, module.collectSupportAccess);
    expect(red.writes.map((w) => [w.tenantId, w.reading.state])).toEqual([
      [ONE, 'closed'],
      [TWO, 'closed'],
    ]);

    const green = fakeSink();
    await collect(garbled, green.sink);
    expect(green.writes).toEqual([]);
  });

  it('RED: a collector that writes closed for a tenant the host did not report, GREEN: the real one leaves it alone', async () => {
    const module = await brokenCollect(
      'closed-for-silence',
      'return { accepted: true, recorded, leftOut, failed };',
      `const said = new Set(parsed.readings.map((r) => r.slug));
      for (const t of await input.sink.listTenantSlugs()) {
        if (said.has(t.slug)) continue;
        await input.sink.recordSupportAccess(
          t.tenantId,
          { state: 'closed', lane: null, grantedAt: null, deadline: null },
          input.now
        );
      }
      return { accepted: true, recorded, leftOut, failed };`
    );
    const oneOnly = [closedFor('placeholder-one', at(-5))];

    const red = fakeSink();
    await collect(oneOnly, red.sink, module.collectSupportAccess);
    expect(red.writes.map((w) => w.tenantId)).toEqual([ONE, TWO]);

    const green = fakeSink();
    await collect(oneOnly, green.sink);
    expect(green.writes.map((w) => w.tenantId)).toEqual([ONE]);
  });
});

describe('sabotage: the collector refuses what it should not write', () => {
  it('RED: without the old-reading check a stale series is written, GREEN: the real one leaves it out', async () => {
    const module = await brokenCollect(
      'no-old-check',
      'if (ageMs > limitMs) {',
      'if (false as boolean) {'
    );
    const stale = [closedFor('placeholder-one', at(-3600))];

    const red = fakeSink();
    await collect(stale, red.sink, module.collectSupportAccess);
    expect(red.writes).toHaveLength(1);

    const green = fakeSink();
    await collect(stale, green.sink);
    expect(green.writes).toEqual([]);
  });

  it('RED: without the future check a series dated ahead is written, GREEN: the real one leaves it out', async () => {
    const module = await brokenCollect(
      'no-future-check',
      'if (ageMs < -limitMs) {',
      'if (false as boolean) {'
    );
    const ahead = [closedFor('placeholder-one', at(3600))];

    const red = fakeSink();
    await collect(ahead, red.sink, module.collectSupportAccess);
    expect(red.writes).toHaveLength(1);

    const green = fakeSink();
    await collect(ahead, green.sink);
    expect(green.writes).toEqual([]);
  });

  it('RED: without the register check an unregistered slug is written, GREEN: the real one leaves it out', async () => {
    const module = await brokenCollect(
      'no-register-check',
      'if (tenantId === undefined) {',
      'if (false as boolean) {'
    );
    const stranger = [closedFor('placeholder-stranger', at(-5))];

    const red = fakeSink();
    await collect(stranger, red.sink, module.collectSupportAccess);
    expect(red.writes).toHaveLength(1);

    const green = fakeSink();
    await collect(stranger, green.sink);
    expect(green.writes).toEqual([]);
  });
});

describe('sabotage: the parser believes nothing the contract does not allow', () => {
  const readSlugs = (parse: typeof parseSupportAccessScrape, text: string): string[] => {
    const outcome = parse(text);
    return outcome.kind === 'read' ? outcome.readings.map((r) => r.slug) : ['refused'];
  };
  const observed = (tenant: string): string =>
    `branchleft_support_access_observed_timestamp_seconds{tenant="${tenant}"} 1.7e9`;

  it('RED: a closed account that carries a deadline is believed when the open-only rule is gone, GREEN: it is left out', async () => {
    const module = await brokenScrape(
      'closed-with-clock',
      "if (state !== 'open' && (lane !== null || grantedText !== null || deadlineText !== null)) {",
      'if (false as boolean) {'
    );
    const text = [
      'branchleft_support_access_state{tenant="placeholder-one",state="closed"} 1',
      'branchleft_support_access_deadline_timestamp_seconds{tenant="placeholder-one"} 1.8e9',
      observed('placeholder-one'),
    ].join('\n');
    expect(readSlugs(module.parseSupportAccessScrape, text)).toEqual(['placeholder-one']);
    expect(readSlugs(parseSupportAccessScrape, text)).toEqual([]);
  });

  it('RED: two states for one tenant are believed when the duplicate rule is gone, GREEN: it is left out', async () => {
    const module = await brokenScrape(
      'two-states',
      'if (state === undefined || otherStates.length > 0) return null;',
      'if (state === undefined) return null;'
    );
    const text = [
      'branchleft_support_access_state{tenant="placeholder-one",state="closed"} 1',
      'branchleft_support_access_state{tenant="placeholder-one",state="open"} 1',
      observed('placeholder-one'),
    ].join('\n');
    expect(readSlugs(module.parseSupportAccessScrape, text)).toEqual(['placeholder-one']);
    expect(readSlugs(parseSupportAccessScrape, text)).toEqual([]);
  });

  it('RED: two host times are believed when the duplicate rule is gone, GREEN: it is left out', async () => {
    const module = await brokenScrape(
      'two-observed',
      'if (observedText === undefined || otherObserved.length > 0) return null;',
      'if (observedText === undefined) return null;'
    );
    const text = [
      'branchleft_support_access_state{tenant="placeholder-one",state="closed"} 1',
      observed('placeholder-one'),
      observed('placeholder-one'),
    ].join('\n');
    expect(readSlugs(module.parseSupportAccessScrape, text)).toEqual(['placeholder-one']);
    expect(readSlugs(parseSupportAccessScrape, text)).toEqual([]);
  });

  it('RED: a malformed series of ours is skipped when the refusal is gone, GREEN: the whole text is refused', async () => {
    const module = await brokenScrape(
      'no-refusal',
      "if (series === undefined) return { kind: 'refused' };",
      'if (series === undefined) continue;'
    );
    const text = [
      exporterText([closedFor('placeholder-one', 1.7e9)]),
      'branchleft_support_access_deadline_timestamp_seconds garbled',
    ].join('\n');
    expect(readSlugs(module.parseSupportAccessScrape, text)).toEqual(['placeholder-one']);
    expect(readSlugs(parseSupportAccessScrape, text)).toEqual(['refused']);
  });
});

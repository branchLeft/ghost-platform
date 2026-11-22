import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthInput, HealthSummary } from '../src/collector/healthCollect.js';
import { parseHealthReport } from '../src/collector/healthReport.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';
import { UNDRAINED_MATCHING, collect, fakeSink, report, ONE } from './healthText.js';

interface CollectModule {
  readonly collectHealth: (input: HealthInput) => Promise<HealthSummary>;
}
interface ReportModule {
  readonly parseHealthReport: typeof parseHealthReport;
}

const COLLECT = 'collector/healthCollect.ts';
const REPORT = 'collector/healthReport.ts';

const brokenCollect = (name: string, target: string, replacement: string): Promise<CollectModule> =>
  importSabotaged<CollectModule>(name, target, replacement, COLLECT);
const brokenReport = (name: string, target: string, replacement: string): Promise<ReportModule> =>
  importSabotaged<ReportModule>(name, target, replacement, REPORT);

beforeAll(clearMutants);
afterAll(clearMutants);

describe('sabotage: a tenant with an unread colour is never written from the colour that answered', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(
      brokenCollect('health-noop', 'text that is not in the module', 'x')
    ).rejects.toThrow('exactly once');
  });

  it('RED: a collector that drops the unread colour and writes the rest shows the tenant healthy, GREEN: the real one writes unknown', async () => {
    const module = await brokenCollect(
      'health-drop-unread',
      'const allRead = texts.length === scrapes.length;',
      'const allRead = true;'
    );
    const text = report([['placeholder-one', [UNDRAINED_MATCHING, null]]]);

    const red = fakeSink();
    await collect(text, red.sink, module.collectHealth);
    expect(red.writes).toEqual([
      { tenantId: ONE, scrapes: [UNDRAINED_MATCHING], observedAt: expect.any(Date) as Date },
    ]);

    const green = fakeSink();
    await collect(text, green.sink);
    expect(green.writes.map((w) => w.scrapes)).toEqual([[]]);
  });

  it('RED: a collector that leaves an unreadable text unwritten keeps the last reading, GREEN: the real one replaces it with unknown', async () => {
    const module = await brokenCollect(
      'health-keep-stale',
      "await input.sink.recordReading(tenantId, [], input.now);\n          outcome = 'unknown: a colour was not readable';",
      "outcome = 'unknown: a colour was not readable';"
    );
    const text = report([['placeholder-one', ['<html>502</html>']]]);

    const red = fakeSink();
    await collect(text, red.sink, module.collectHealth);
    expect(red.writes).toEqual([]);

    const green = fakeSink();
    await collect(text, green.sink);
    expect(green.writes.map((w) => w.scrapes)).toEqual([[]]);
  });

  it('RED: a collector that writes a refused report writes tenants it should not trust, GREEN: the real one writes none', async () => {
    const module = await brokenCollect(
      'health-use-refused',
      "if (parsed.kind === 'refused') {",
      "if (parsed.kind === 'never') {"
    );
    const text = '{"tenants":[],"extra":1}';

    const red = await collect(text, fakeSink().sink, module.collectHealth).catch(
      (error: unknown) => error
    );
    expect(red).toBeInstanceOf(Error);

    const green = await collect(text, fakeSink().sink);
    expect(green.summary.accepted).toBe(false);
  });

  it('RED: a parser that lets a repeated slug through lets the later colour overwrite the earlier, GREEN: the real one refuses', async () => {
    const module = await brokenReport(
      'report-repeat',
      '|| seen.has(slug)) return REFUSED;',
      ') return REFUSED;'
    );
    const text = report([
      ['placeholder-one', [UNDRAINED_MATCHING]],
      ['placeholder-one', [null]],
    ]);
    expect(module.parseHealthReport(text).kind).toBe('read');
    expect(parseHealthReport(text).kind).toBe('refused');
  });
});

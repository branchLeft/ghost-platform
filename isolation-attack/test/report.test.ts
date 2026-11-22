import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASE_SPECS } from '../src/cases.ts';
import { CASE_IDS, type CaseResult, type RunResult } from '../src/model.ts';
import {
  ReportError,
  assertComplete,
  escapeHtml,
  isoDateOf,
  proseDateOf,
  renderReport,
  reportFileName,
  suitePassed,
  summaryLine,
} from '../src/report.ts';
import { parseResult, writeReport } from '../src/reportCli.ts';

function heldCase(id: (typeof CASE_IDS)[number]): CaseResult {
  const spec = CASE_SPECS.find((s) => s.id === id)!;
  return {
    id,
    title: spec.title,
    control: spec.control,
    verdict: 'held',
    summary: 'the control held',
    vectors: [{ vector: 'v', outcome: 'blocked', evidence: 'refused <b>403</b>' }],
    sabotage: { mode: 'no-csp', verdict: 'breached', wentRed: true, summary: 'went red' },
  };
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schema: 1,
    startedAt: '2026-11-19T09:00:00.000Z',
    finishedAt: '2026-11-19T09:12:30.000Z',
    target: {
      kind: 'local-rig',
      sharedDomain: 'sites.pp.localhost',
      rootDomain: 'pp.localhost',
      tenantHosts: ['a.sites.pp.localhost', 'b.sites.pp.localhost'],
      portalHost: 'portal.pp.localhost',
      psl: 'absent',
    },
    images: [
      {
        role: 'Tenant Ghost',
        reference: 'isolation-attack-ghost:local',
        imageId: `sha256:${'1'.repeat(64)}`,
        repoDigests: [],
        source: 'inspected',
      },
      {
        role: 'Edge',
        reference: 'caddy:2-alpine',
        imageId: `sha256:${'2'.repeat(64)}`,
        repoDigests: [`caddy@sha256:${'3'.repeat(64)}`],
        source: 'inspected',
      },
    ],
    browser: { name: 'chromium', version: '153.0.0.0' },
    revision: 'a'.repeat(40),
    cases: CASE_IDS.map(heldCase),
    ...overrides,
  };
}

describe('the dated report', () => {
  it('dates the note from the run own finish time', () => {
    expect(isoDateOf('2026-11-19T09:12:30.000Z')).toBe('2026-11-19');
    expect(proseDateOf('2026-11-19T09:12:30.000Z')).toBe('19 Nov 2026');
    expect(reportFileName(result())).toBe('2026-11-19-cookie-isolation-attack-local-rig.html');
  });

  it('refuses a time that is not a UTC timestamp', () => {
    expect(() => isoDateOf('yesterday')).toThrow(ReportError);
  });

  it('carries every case, every image id and every digest', () => {
    const html = renderReport(result());
    for (const spec of CASE_SPECS) expect(html).toContain(spec.title);
    expect(html).toContain(`sha256:${'1'.repeat(64)}`);
    expect(html).toContain(`caddy@sha256:${'3'.repeat(64)}`);
    expect(html).toContain('none (built locally)');
    expect(html).toContain('<b>Dated note, 19 Nov 2026.</b>');
    expect(html).toContain('7 of 7 cases held');
  });

  it('escapes what the attack evidence says', () => {
    const html = renderReport(result());
    expect(html).toContain('refused &lt;b&gt;403&lt;/b&gt;');
    expect(html).not.toContain('refused <b>403</b>');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });

  it('names a breached case in the summary line and does not pass the suite', () => {
    const cases = CASE_IDS.map(heldCase);
    cases[6] = { ...cases[6]!, verdict: 'breached' };
    const r = result({ cases });
    expect(summaryLine(r)).toBe('6 of 7 cases held; breached: theme-script');
    expect(suitePassed(r)).toBe(false);
    expect(renderReport(r)).toContain('class="bad">Breached');
  });

  it('does not pass a suite whose sabotage did not go red', () => {
    const cases = CASE_IDS.map(heldCase);
    cases[0] = {
      ...cases[0]!,
      sabotage: { mode: 'no-upload-guard', verdict: 'held', wentRed: false, summary: 'no' },
    };
    const r = result({ cases });
    expect(suitePassed(r)).toBe(false);
    expect(renderReport(r)).toContain('cannot see this control');
  });

  it('shows a deployed run as such, with the list state', () => {
    const r = result({
      target: { ...result().target, kind: 'deployed', psl: 'present' },
      images: [
        {
          role: 'Supplied',
          reference: `x@sha256:${'4'.repeat(64)}`,
          imageId: null,
          repoDigests: [`x@sha256:${'4'.repeat(64)}`],
          source: 'supplied',
        },
      ],
    });
    const html = renderReport(r);
    expect(html).toContain('the deployed shared domain');
    expect(html).toContain('stated to be in place');
    expect(html).toContain('supplied by the operator');
    expect(reportFileName(r)).toContain('-deployed.html');
  });

  it('refuses a result that omits or repeats a case', () => {
    expect(() => assertComplete(result({ cases: CASE_IDS.slice(1).map(heldCase) }))).toThrow(
      ReportError
    );
    expect(() =>
      assertComplete(result({ cases: [...CASE_IDS.map(heldCase), heldCase('inline-script')] }))
    ).toThrow(ReportError);
  });

  it('renders the same bytes for the same result', () => {
    expect(renderReport(result())).toBe(renderReport(result()));
  });
});

describe('the report command', () => {
  it('writes the dated fragment and the result file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolation-report-'));
    const written = writeReport(result(), dir);
    expect(written.html).toBe(join(dir, '2026-11-19-cookie-isolation-attack-local-rig.html'));
    expect(readFileSync(written.html, 'utf-8')).toContain('Dated note, 19 Nov 2026');
    expect(parseResult(readFileSync(written.json, 'utf-8')).cases).toHaveLength(7);
  });

  it('rejects a file that is not a results file', () => {
    expect(() => parseResult('{"schema":2}')).toThrow(/schema 1/);
    expect(() => parseResult('[]')).toThrow(/schema 1/);
  });

  it('runs under Node with no build step and exits 0 only for a passing suite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolation-report-'));
    const input = join(dir, 'results.json');
    const cli = fileURLToPath(new URL('../src/reportCli.ts', import.meta.url));
    writeFileSync(input, JSON.stringify(result()));
    const out = execFileSync('node', [cli, '--results', input, '--out', join(dir, 'out')], {
      encoding: 'utf-8',
    });
    expect(out).toContain('7 of 7 cases held');

    const cases = CASE_IDS.map(heldCase);
    cases[2] = { ...cases[2]!, verdict: 'breached' };
    writeFileSync(input, JSON.stringify(result({ cases })));
    expect(() =>
      execFileSync('node', [cli, '--results', input, '--out', join(dir, 'out')], { stdio: 'pipe' })
    ).toThrow();
  });
});

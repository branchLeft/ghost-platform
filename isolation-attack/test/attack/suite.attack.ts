import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CASE_IDS, type RunResult } from '../../src/model.ts';
import { suitePassed } from '../../src/report.ts';
import { writeReport } from '../../src/reportCli.ts';
import { runSuite } from '../../src/suite.ts';
import { targetFromEnv } from '../../src/target.ts';

// The live suite. With no ATTACK_BASE_URL it builds the local rig of two
// disposable tenants and attacks that; with one it attacks the deployed shared
// domain (see README.md). It runs once: the cases share a rig, and the report is
// written from the single result.

const OUT = resolve(process.env['ATTACK_RESULTS_DIR'] ?? 'results');

let result: RunResult;

beforeAll(async () => {
  result = await runSuite(targetFromEnv(process.env), (line) => process.stderr.write(`${line}\n`));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  const written = writeReport(result, OUT);
  process.stderr.write(`report: ${written.html}\n`);
});

describe('tenant isolation on the shared domain', () => {
  it.each(CASE_IDS)('%s: the control holds', (id) => {
    const found = result.cases.find((c) => c.id === id);
    expect(found, `case ${id} ran`).toBeDefined();
    expect({ verdict: found?.verdict, summary: found?.summary }).toEqual({
      verdict: 'held',
      summary: found?.summary,
    });
  });

  it.each(CASE_IDS)('%s: the case goes red when its control is switched off', (id) => {
    const found = result.cases.find((c) => c.id === id);
    if (found?.sabotage === null || found === undefined) return;
    expect({ mode: found.sabotage.mode, wentRed: found.sabotage.wentRed }).toEqual({
      mode: found.sabotage.mode,
      wentRed: true,
    });
  });

  it('the whole suite passed', () => {
    expect(suitePassed(result)).toBe(true);
  });
});

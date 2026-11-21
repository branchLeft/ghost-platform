// Turns a run's results.json into the dated report fragment.
//   node src/reportCli.ts --results results/results.json --out <directory>
// The directory is wherever the cookie isolation design note lives; that is a
// separate repository, so the default is this package's own results/ directory
// and the fragment is copied across by whoever lands the note.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { RunResult } from './model.ts';
import { renderReport, reportFileName, suitePassed, summaryLine } from './report.ts';

export function parseResult(text: string): RunResult {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== 1 ||
    !Array.isArray((parsed as { cases?: unknown }).cases)
  ) {
    throw new Error('not a results file this version of the suite wrote (schema 1)');
  }
  return parsed as RunResult;
}

export function writeReport(result: RunResult, outDir: string): { html: string; json: string } {
  const html = renderReport(result);
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, reportFileName(result));
  const jsonPath = htmlPath.replace(/\.html$/, '.json');
  writeFileSync(htmlPath, html);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  return { html: htmlPath, json: jsonPath };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      results: { type: 'string', default: 'results/results.json' },
      out: { type: 'string', default: 'results' },
    },
  });
  const result = parseResult(readFileSync(values.results, 'utf-8'));
  const written = writeReport(result, values.out);
  process.stdout.write(`${summaryLine(result)}\n${written.html}\n${written.json}\n`);
  process.exitCode = suitePassed(result) ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

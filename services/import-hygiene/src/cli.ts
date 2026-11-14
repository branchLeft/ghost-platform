#!/usr/bin/env node
// import-hygiene check --in LIST.csv --suppression S.csv --consent C.json --out CLEAN.csv --report REPORT.json
//
// Writes the clean list and a report of counts, reasons and row numbers. The
// report and every printed line carry no address; only the clean list does.
import { readFile, writeFile } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { checkList, type DomainLookupFn, type DropReason, type ListRow } from './checkList.js';
import { parseConsentRecord } from './consentRecord.js';
import { parseCsv, writeCsv } from './csv.js';
import { domainLookupWith } from './dnsLookup.js';

export interface CliIo {
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  lookupDomain: DomainLookupFn;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
}

const USAGE =
  'usage: import-hygiene check --in LIST.csv --suppression S.csv --consent C.json --out CLEAN.csv --report REPORT.json';
const REQUIRED_FLAGS = ['--in', '--suppression', '--consent', '--out', '--report'] as const;
const DROP_REASONS: readonly DropReason[] = ['syntax', 'suppressed', 'no-mx-or-address'];
// Stands in for a consent file that is present but not JSON: it parses as a string,
// which the consent rules treat as an invalid shape.
const NOT_JSON = 'not-json';

class UsageError extends Error {}

interface CheckArgs {
  readonly in: string;
  readonly suppression: string;
  readonly consent: string;
  readonly out: string;
  readonly report: string;
}

function parseCheckArgs(argv: readonly string[]): CheckArgs {
  if (argv[0] !== 'check') {
    throw new UsageError(USAGE);
  }
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      flag === undefined ||
      !REQUIRED_FLAGS.includes(flag as (typeof REQUIRED_FLAGS)[number]) ||
      value === undefined
    ) {
      throw new UsageError(USAGE);
    }
    values.set(flag, value);
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!values.has(flag)) {
      throw new UsageError(USAGE);
    }
  }
  return {
    in: values.get('--in') ?? '',
    suppression: values.get('--suppression') ?? '',
    consent: values.get('--consent') ?? '',
    out: values.get('--out') ?? '',
    report: values.get('--report') ?? '',
  };
}

function emailColumn(header: readonly string[], label: string): number {
  const index = header.indexOf('email');
  if (index === -1) {
    throw new Error(`${label} has no email column`);
  }
  return index;
}

function summary(rows: readonly number[]) {
  return { count: rows.length, rows: [...rows] };
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: CheckArgs;
  try {
    args = parseCheckArgs(argv);
  } catch (error) {
    io.err(error instanceof UsageError ? error.message : USAGE);
    return 2;
  }
  try {
    const listText = await io.readText(args.in);
    if (listText === undefined) {
      io.err('list file not found');
      return 1;
    }
    const suppressionText = await io.readText(args.suppression);
    if (suppressionText === undefined) {
      // A missing suppression list must stop the run, not pass every address.
      io.err('suppression file not found');
      return 1;
    }
    const consentText = await io.readText(args.consent);
    let consentInput: unknown;
    if (consentText === undefined) {
      consentInput = undefined;
    } else {
      try {
        consentInput = JSON.parse(consentText);
      } catch {
        consentInput = NOT_JSON;
      }
    }

    const list = parseCsv(listText);
    const listEmail = emailColumn(list.header, 'list');
    const suppression = parseCsv(suppressionText);
    const suppressionEmail = emailColumn(suppression.header, 'suppression');

    const rows: ListRow[] = list.rows.map((cells, index) => ({
      row: index + 1,
      address: cells[listEmail] ?? '',
    }));
    const suppressed = suppression.rows.map((cells) => cells[suppressionEmail] ?? '');
    const consent = parseConsentRecord(consentInput, io.now());
    const result = await checkList(rows, { suppressed, lookupDomain: io.lookupDomain });

    const cleanRows = result.kept.map(({ row }) => list.rows[row - 1] ?? []);
    await io.writeText(args.out, writeCsv(list.header, cleanRows));

    const droppedRows = (reason: DropReason) =>
      result.dropped.filter((d) => d.reason === reason).map((d) => d.row);
    const dropped: Record<string, ReturnType<typeof summary>> = {};
    for (const reason of DROP_REASONS) {
      dropped[reason] = summary(droppedRows(reason));
    }
    const report = {
      consent:
        consent.needsReconfirmation === true
          ? { needsReconfirmation: true, problem: consent.problem }
          : { needsReconfirmation: false },
      rowsIn: rows.length,
      kept: result.kept.length,
      dropped,
      unknownLookup: summary(result.unknownRows),
    };
    await io.writeText(args.report, JSON.stringify(report, null, 2) + '\n');
    io.out(
      `rows in ${rows.length}, kept ${result.kept.length}, dropped ${result.dropped.length}, unknown lookup ${result.unknownRows.length}`
    );
    return 0;
  } catch (error) {
    // Error messages here name a file or a column, never a cell value.
    io.err(
      `import-hygiene check failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    return 1;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

function nodeIo(): CliIo {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  return {
    readText: readOptional,
    writeText: (path, text) => writeFile(path, text, 'utf8'),
    lookupDomain: domainLookupWith(resolver),
    now: () => new Date(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), nodeIo()).then((code) => {
    process.exitCode = code;
  });
}

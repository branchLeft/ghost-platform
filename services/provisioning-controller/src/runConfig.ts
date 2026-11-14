import { isAbsolute } from 'node:path';
import { type CommandSpec } from './commandHost.js';
import type { RetryPolicy } from './executePorts.js';
import { ENTRY_POINTS, type EntryPoint } from './plan.js';

/** What one deployment decides: where the files are and which program serves each entry point. */
export interface RunConfig {
  readonly stateFile: string;
  readonly approvalsFile: string;
  readonly registerFile: string;
  readonly hosts: Readonly<Partial<Record<EntryPoint, CommandSpec>>>;
  readonly retry?: RetryPolicy;
  readonly reportTimeoutMs?: number;
}

export class RunConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The run configuration is unusable: ${problems.join('; ')}.`);
    this.name = 'RunConfigError';
  }
}

const TOP_KEYS = [
  'stateFile',
  'approvalsFile',
  'registerFile',
  'hosts',
  'retry',
  'reportTimeoutMs',
];
const MAX_TIMEOUT_MS = 3_600_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isAbsolutePath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !v.includes('\0') && isAbsolute(v);
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function parseSpec(name: string, raw: unknown, problems: string[]): CommandSpec | undefined {
  if (!isRecord(raw)) {
    problems.push(`hosts.${name} is not an object`);
    return undefined;
  }
  const extra = Object.keys(raw).filter((k) => k !== 'argv' && k !== 'timeoutMs');
  if (extra.length > 0) problems.push(`hosts.${name} has unknown keys: ${extra.join(', ')}`);
  const argv = raw['argv'];
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((a) => typeof a === 'string' && a.length > 0 && !a.includes('\0'))
  ) {
    problems.push(`hosts.${name}.argv is not a list of non-empty text`);
    return undefined;
  }
  if (!isAbsolutePath(argv[0])) {
    problems.push(`hosts.${name}.argv[0] is not an absolute path`);
    return undefined;
  }
  const timeoutMs = raw['timeoutMs'];
  if (
    timeoutMs !== undefined &&
    !(isWhole(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)
  ) {
    problems.push(
      `hosts.${name}.timeoutMs is not a whole number of milliseconds up to ${MAX_TIMEOUT_MS}`
    );
    return undefined;
  }
  return { argv: argv as readonly string[], ...(timeoutMs !== undefined && { timeoutMs }) };
}

/** Refuses anything it does not know: a misspelt key is a mistake to name, not a setting to ignore. */
export function parseRunConfig(value: unknown): RunConfig {
  if (!isRecord(value)) throw new RunConfigError(['the configuration is not an object']);
  const problems: string[] = [];
  const unknown = Object.keys(value).filter((k) => !TOP_KEYS.includes(k));
  if (unknown.length > 0) problems.push(`unknown keys: ${unknown.join(', ')}`);

  for (const field of ['stateFile', 'approvalsFile', 'registerFile'] as const) {
    if (!isAbsolutePath(value[field])) problems.push(`${field} is not an absolute path`);
  }

  const hosts: Partial<Record<EntryPoint, CommandSpec>> = {};
  const rawHosts = value['hosts'];
  if (!isRecord(rawHosts)) problems.push('hosts is not an object');
  else {
    for (const [name, raw] of Object.entries(rawHosts)) {
      if (!(ENTRY_POINTS as readonly string[]).includes(name)) {
        problems.push(`hosts.${name} is not an entry point`);
        continue;
      }
      const spec = parseSpec(name, raw, problems);
      if (spec !== undefined) hosts[name as EntryPoint] = spec;
    }
  }

  let retry: RetryPolicy | undefined;
  const rawRetry = value['retry'];
  if (rawRetry !== undefined) {
    if (
      isRecord(rawRetry) &&
      isWhole(rawRetry['maxAttempts']) &&
      isWhole(rawRetry['baseDelayMs']) &&
      isWhole(rawRetry['maxDelayMs']) &&
      Object.keys(rawRetry).length === 3
    ) {
      retry = {
        maxAttempts: rawRetry['maxAttempts'],
        baseDelayMs: rawRetry['baseDelayMs'],
        maxDelayMs: rawRetry['maxDelayMs'],
      };
    } else
      problems.push('retry needs exactly maxAttempts, baseDelayMs and maxDelayMs, whole numbers');
  }
  const reportTimeoutMs = value['reportTimeoutMs'];
  if (reportTimeoutMs !== undefined && !isWhole(reportTimeoutMs)) {
    problems.push('reportTimeoutMs is not a whole number');
  }

  if (problems.length > 0) throw new RunConfigError(problems);
  return {
    stateFile: value['stateFile'] as string,
    approvalsFile: value['approvalsFile'] as string,
    registerFile: value['registerFile'] as string,
    hosts,
    ...(retry !== undefined && { retry }),
    ...(reportTimeoutMs !== undefined && { reportTimeoutMs: reportTimeoutMs as number }),
  };
}

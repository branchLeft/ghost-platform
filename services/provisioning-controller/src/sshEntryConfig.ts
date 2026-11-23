import { isAbsolute } from 'node:path';
import type { TenantEntryFiles } from './fileTenantEntryInputs.js';
import { invalidSshSettings, type SshEndpoint, type SshEntryConfig } from './sshEntryTransport.js';

/**
 * The run configuration's optional `sshEntry` section: how the app host's forced command is
 * reached. Absent, nothing about ssh is read or started. Present, it carries no default: the key
 * file, the pinned known-hosts file, the hop list (empty for a direct host) and the target are all
 * named, and the same checks the transport makes when it is built are made here too, so a bad
 * value is named at configuration time.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const REQUIRED_KEYS = ['keyFile', 'knownHostsFile', 'jumpHops', 'target', 'inputs'] as const;
const INPUT_KEYS = ['secretsFile', 'stackFile', 'deployKeyFile'] as const;

/** What the section holds: the transport's settings, and the files the tenant entry inputs are read from. */
export interface ParsedSshEntry {
  readonly transport: SshEntryConfig;
  readonly files: TenantEntryFiles;
}

function parseInputFiles(raw: unknown, problems: string[]): TenantEntryFiles | undefined {
  if (!isRecord(raw)) {
    problems.push('sshEntry.inputs is not an object');
    return undefined;
  }
  const before = problems.length;
  const extra = Object.keys(raw).filter((k) => !(INPUT_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) problems.push(`sshEntry.inputs has unknown keys: ${extra.join(', ')}`);
  for (const key of INPUT_KEYS) {
    const value = raw[key];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      !isAbsolute(value)
    ) {
      problems.push(`sshEntry.inputs.${key} is not an absolute path`);
    }
  }
  if (problems.length > before) return undefined;
  return {
    secretsFile: raw['secretsFile'] as string,
    stackFile: raw['stackFile'] as string,
    deployKeyFile: raw['deployKeyFile'] as string,
  };
}
const OPTIONAL_KEYS = [
  'sshConfigFile',
  'sshProgram',
  'timeoutMs',
  'connectTimeoutSeconds',
  'maxOutputBytes',
  'maxPayloadBytes',
] as const;
const ENDPOINT_KEYS = ['user', 'host', 'port'];

function parseEndpoint(name: string, raw: unknown, problems: string[]): SshEndpoint | undefined {
  if (!isRecord(raw)) {
    problems.push(`${name} is not an object`);
    return undefined;
  }
  const extra = Object.keys(raw).filter((k) => !ENDPOINT_KEYS.includes(k));
  if (extra.length > 0) problems.push(`${name} has unknown keys: ${extra.join(', ')}`);
  // Types are judged by `invalidSshSettings`, which names `<name>.user` and the like.
  return {
    user: raw['user'] as string,
    host: raw['host'] as string,
    ...(raw['port'] !== undefined && { port: raw['port'] as number }),
  };
}

/** Appends what is wrong to `problems`; returns the settings only when there is nothing wrong. */
export function parseSshEntry(raw: unknown, problems: string[]): ParsedSshEntry | undefined {
  const before = problems.length;
  if (!isRecord(raw)) {
    problems.push('sshEntry is not an object');
    return undefined;
  }
  const known: readonly string[] = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length > 0) problems.push(`sshEntry has unknown keys: ${unknown.join(', ')}`);
  for (const key of REQUIRED_KEYS) {
    if (raw[key] === undefined) problems.push(`sshEntry.${key} is required`);
  }

  const target =
    raw['target'] === undefined
      ? undefined
      : parseEndpoint('sshEntry.target', raw['target'], problems);
  let jumpHops: SshEndpoint[] | undefined;
  const rawHops = raw['jumpHops'];
  if (rawHops !== undefined) {
    if (!Array.isArray(rawHops)) problems.push('sshEntry.jumpHops is not a list');
    else {
      jumpHops = [];
      rawHops.forEach((hop: unknown, i) => {
        const parsed = parseEndpoint(`sshEntry.jumpHops[${String(i)}]`, hop, problems);
        if (parsed !== undefined) jumpHops?.push(parsed);
      });
    }
  }
  const files = raw['inputs'] === undefined ? undefined : parseInputFiles(raw['inputs'], problems);
  if (problems.length > before || target === undefined || jumpHops === undefined) return undefined;
  if (files === undefined) return undefined;

  const settings = {
    keyFile: raw['keyFile'] as string,
    knownHostsFile: raw['knownHostsFile'] as string,
    jumpHops,
    target,
    ...(raw['sshConfigFile'] !== undefined && { sshConfigFile: raw['sshConfigFile'] as string }),
    ...(raw['sshProgram'] !== undefined && { sshProgram: raw['sshProgram'] as string }),
    ...(raw['timeoutMs'] !== undefined && { timeoutMs: raw['timeoutMs'] as number }),
    ...(raw['connectTimeoutSeconds'] !== undefined && {
      connectTimeoutSeconds: raw['connectTimeoutSeconds'] as number,
    }),
    ...(raw['maxOutputBytes'] !== undefined && { maxOutputBytes: raw['maxOutputBytes'] as number }),
    ...(raw['maxPayloadBytes'] !== undefined && {
      maxPayloadBytes: raw['maxPayloadBytes'] as number,
    }),
  } satisfies SshEntryConfig;
  for (const name of invalidSshSettings(settings)) problems.push(`sshEntry.${name} is not usable`);
  return problems.length > before ? undefined : { transport: settings, files };
}

/** Where the tenant database host is reached and where the controller holds a minted password. */
export interface ParsedDbEntry {
  readonly target: SshEndpoint;
  readonly handOverDir: string;
}

/**
 * The `dbEntry` section: the tenant database host's account and the directory for the hand-over copy.
 * The key, pinned known-hosts file, hops and limits are `sshEntry`'s: one key reaches both targets.
 */
export function parseDbEntry(
  raw: unknown,
  ssh: SshEntryConfig,
  problems: string[]
): ParsedDbEntry | undefined {
  const before = problems.length;
  if (!isRecord(raw)) {
    problems.push('dbEntry is not an object');
    return undefined;
  }
  const unknown = Object.keys(raw).filter((k) => k !== 'target' && k !== 'handOverDir');
  if (unknown.length > 0) problems.push(`dbEntry has unknown keys: ${unknown.join(', ')}`);
  const dir = raw['handOverDir'];
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0') || !isAbsolute(dir)) {
    problems.push('dbEntry.handOverDir is not an absolute path');
  }
  const target =
    raw['target'] === undefined
      ? undefined
      : parseEndpoint('dbEntry.target', raw['target'], problems);
  if (raw['target'] === undefined) problems.push('dbEntry.target is required');
  if (target !== undefined) {
    for (const name of invalidSshSettings({ ...ssh, target })) {
      if (name.startsWith('target')) problems.push(`dbEntry.${name} is not usable`);
    }
  }
  if (problems.length > before || target === undefined) return undefined;
  return { target, handOverDir: dir as string };
}

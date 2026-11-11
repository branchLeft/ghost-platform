import { readFileSync } from 'node:fs';
import { decodeSecret } from './signature.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  host: string;
  port: number;
  drainHost: string;
  drainPort: number;
  stateDir: string;
  secrets: Buffer[];
  drainToken: string;
  outcomeHeader: string | undefined;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
}

/** What the URL parser makes of every spelling of the IPv4 and IPv6 unspecified address. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '[::]', '[::ffff:0:0]']);
const MIN_DRAIN_TOKEN_CHARS = 32;

/**
 * True for any spelling of an all-interfaces address: `::0`, the expanded
 * IPv6 form, the IPv4-mapped form, and the short IPv4 forms such as `0`, `0.0`
 * and `0x0`. The WHATWG URL parser reduces each of those to one canonical host.
 */
function isWildcard(value: string): boolean {
  const bare = value.startsWith('[') ? value.slice(1, -1) : value;
  const literal = bare.includes(':') ? `[${bare}]` : bare;
  try {
    return WILDCARD_HOSTS.has(new URL(`http://${literal}`).hostname);
  } catch {
    return false;
  }
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function port(env: Env, name: string): number {
  const text = required(env, name);
  const n = Number(text);
  if (!/^[0-9]{1,5}$/.test(text) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a port number`);
  }
  return n;
}

function privateHost(env: Env, name: string): string {
  const value = required(env, name);
  if (isWildcard(value)) {
    throw new Error(`${name} must be a specific address, never a wildcard`);
  }
  return value;
}

function milliseconds(env: Env, name: string, fallback: number): number {
  const text = env[name];
  if (text === undefined || text === '') {
    return fallback;
  }
  if (!/^[0-9]{1,6}$/.test(text) || Number(text) < 1) {
    throw new Error(`${name} must be a positive number of milliseconds`);
  }
  return Number(text);
}

/**
 * Every setting arrives by environment variable; secrets and the drain token
 * arrive as file paths so they never sit in a process listing or a unit file.
 * A missing or malformed value stops startup: nothing here has a default that
 * would widen what the receiver exposes.
 */
export function loadConfig(
  env: Env,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8')
): Config {
  const host = privateHost(env, 'WEBHOOK_HOST');
  const listenPort = port(env, 'WEBHOOK_PORT');
  const drainHost = privateHost(env, 'WEBHOOK_DRAIN_HOST');
  const drainPort = port(env, 'WEBHOOK_DRAIN_PORT');
  if (host === drainHost && listenPort === drainPort) {
    throw new Error('the webhook and drain listeners must not share an address and port');
  }

  const secrets = [decodeSecret(readText(required(env, 'WEBHOOK_SECRET_FILE')))];
  const previous = env['WEBHOOK_SECRET_FILE_PREVIOUS'];
  if (previous !== undefined && previous.trim() !== '') {
    secrets.push(decodeSecret(readText(previous.trim())));
  }

  const drainToken = readText(required(env, 'WEBHOOK_DRAIN_TOKEN_FILE')).trim();
  if (drainToken.length < MIN_DRAIN_TOKEN_CHARS) {
    throw new Error(`the drain token must be at least ${MIN_DRAIN_TOKEN_CHARS} characters`);
  }

  const header = env['WEBHOOK_OUTCOME_HEADER'];
  return {
    host,
    port: listenPort,
    drainHost,
    drainPort,
    stateDir: required(env, 'WEBHOOK_STATE_DIR'),
    secrets,
    drainToken,
    outcomeHeader:
      header === undefined || header.trim() === '' ? undefined : header.trim().toLowerCase(),
    headersTimeoutMs: milliseconds(env, 'WEBHOOK_HEADERS_TIMEOUT_MS', 5000),
    requestTimeoutMs: milliseconds(env, 'WEBHOOK_REQUEST_TIMEOUT_MS', 10000),
    keepAliveTimeoutMs: milliseconds(env, 'WEBHOOK_KEEP_ALIVE_TIMEOUT_MS', 5000),
  };
}

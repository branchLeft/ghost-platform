import { readFileSync } from 'node:fs';
import type { BlockList } from 'node:net';
import { MIN_KEY_BYTES } from './cookie.js';
import { parseTrustedProxies } from './source.js';

export interface GateConfig {
  readonly port: number;
  readonly host: string;
  readonly slotsPath: string;
  readonly leaseDir: string;
  readonly signingKey: Buffer;
  readonly trustedProxies: BlockList;
  readonly cookieTtlSeconds: number;
  readonly ceilingLimit: number;
  readonly ceilingWindowMs: number;
  readonly ceilingMaxSources: number;
  readonly argon2MaxConcurrent: number;
  readonly argon2MaxQueued: number;
}

export type GateEnv = Record<string, string | undefined>;

function requireEnv(env: GateEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(env: GateEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}`);
  }
  return Number(raw);
}

/**
 * Every input that decides who is admitted has no default: the slots file,
 * the lease directory and the signing key. An unset value refuses to start
 * rather than guessing. The key is read from a file so it never appears in
 * the process environment, and must be at least 32 bytes.
 */
export function loadConfig(
  env: GateEnv,
  readKey: (path: string) => Buffer = (path) => readFileSync(path)
): GateConfig {
  const signingKey = readKey(requireEnv(env, 'GATE_SIGNING_KEY_FILE'));
  if (signingKey.length < MIN_KEY_BYTES) {
    throw new Error(`GATE_SIGNING_KEY_FILE must hold at least ${MIN_KEY_BYTES} bytes`);
  }
  return {
    port: positiveInteger(env, 'PORT', 8080, 65535),
    host: env.LISTEN_HOST || '127.0.0.1',
    slotsPath: requireEnv(env, 'GATE_SLOTS_FILE'),
    leaseDir: requireEnv(env, 'GATE_LEASE_DIR'),
    signingKey,
    trustedProxies: parseTrustedProxies(env.GATE_TRUSTED_PROXIES ?? ''),
    cookieTtlSeconds: positiveInteger(env, 'GATE_COOKIE_TTL_SECONDS', 12 * 3600, 7 * 24 * 3600),
    ceilingLimit: positiveInteger(env, 'GATE_CEILING_ATTEMPTS', 10, 1000),
    ceilingWindowMs: positiveInteger(env, 'GATE_CEILING_WINDOW_SECONDS', 900, 86400) * 1000,
    ceilingMaxSources: positiveInteger(env, 'GATE_CEILING_MAX_SOURCES', 100_000, 10_000_000),
    // Design amended (LLD-5 silent, incidental): bounded at 4 concurrent --
    // Node's `crypto.argon2` runs on the libuv threadpool, whose own default
    // size is 4, so admitting more here would only grow a second queue
    // behind the one libuv already keeps, without buying real parallelism.
    // 64 concurrent waiters is the queue's own cap, so a flood is refused
    // once it would hold more pending derivations than that.
    argon2MaxConcurrent: positiveInteger(env, 'GATE_ARGON2_MAX_CONCURRENT', 4, 64),
    argon2MaxQueued: positiveInteger(env, 'GATE_ARGON2_MAX_QUEUED', 64, 10_000),
  };
}

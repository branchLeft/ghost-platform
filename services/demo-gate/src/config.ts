import { readFileSync } from 'node:fs';
import type { BlockList } from 'node:net';
import { MIN_KEY_BYTES } from './cookie.js';
import { isLoopbackHost, parseTrustedProxies } from './source.js';

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
  readonly ceilingBroadLimit: number;
  readonly ceilingBroadMaxSources: number;
  readonly argon2MaxConcurrent: number;
  readonly argon2MaxQueued: number;
  /**
   * Absent by default: a deployment that never sets
   * `GATE_TRAFFIC_COUNTER_DIR` simply does not count real traffic, and
   * `services/broker`'s own pre-stop check reads that absence as "hasn't
   * served" and fails closed -- see `trafficCounter.ts`'s own doc comment.
   * Not `requireEnv`'d like the slots file or the signing key: unlike
   * those, an unset value here degrades one downstream check safely
   * rather than admitting a request it should have refused.
   */
  readonly trafficCounterDir?: string;
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
  const host = env.LISTEN_HOST || '127.0.0.1';
  const trustedProxies = parseTrustedProxies(env.GATE_TRUSTED_PROXIES ?? '');
  // An empty list stays "trust nobody". On a loopback listener that is a
  // misconfiguration, not a posture: the only possible peer is the local
  // edge, so every visitor would share one ceiling bucket.
  if (isLoopbackHost(host) && trustedProxies.rules.length === 0) {
    throw new Error(
      `GATE_TRUSTED_PROXIES must name the edge when the gate listens on loopback (${host}): ` +
        'with no trusted proxy every visitor shares the edge as one source.'
    );
  }
  return {
    port: positiveInteger(env, 'PORT', 8080, 65535),
    host,
    slotsPath: requireEnv(env, 'GATE_SLOTS_FILE'),
    leaseDir: requireEnv(env, 'GATE_LEASE_DIR'),
    signingKey,
    trustedProxies,
    cookieTtlSeconds: positiveInteger(env, 'GATE_COOKIE_TTL_SECONDS', 12 * 3600, 7 * 24 * 3600),
    ceilingLimit: positiveInteger(env, 'GATE_CEILING_ATTEMPTS', 10, 1000),
    ceilingWindowMs: positiveInteger(env, 'GATE_CEILING_WINDOW_SECONDS', 900, 86400) * 1000,
    ceilingMaxSources: positiveInteger(env, 'GATE_CEILING_MAX_SOURCES', 100_000, 10_000_000),
    // A second, coarser ceiling over the same window: one bucket per IPv6
    // /48 rather than /64. See ../README.md#the-broad-ceilings-default-of-1000.
    ceilingBroadLimit: positiveInteger(env, 'GATE_CEILING_BROAD_ATTEMPTS', 1_000, 20_000),
    ceilingBroadMaxSources: positiveInteger(
      env,
      'GATE_CEILING_BROAD_MAX_SOURCES',
      20_000,
      2_000_000
    ),
    // Bounded at 3, one below Node's default libuv threadpool size (4),
    // which `crypto.argon2` and `fs` share.
    // See ../README.md#the-argon2-concurrency-caps-default-of-3.
    argon2MaxConcurrent: positiveInteger(env, 'GATE_ARGON2_MAX_CONCURRENT', 3, 64),
    argon2MaxQueued: positiveInteger(env, 'GATE_ARGON2_MAX_QUEUED', 64, 10_000),
    trafficCounterDir: env.GATE_TRAFFIC_COUNTER_DIR || undefined,
  };
}

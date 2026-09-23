export interface ShimConfig {
  port: number;
  dbPath: string;
  throttlePath?: string;
  messagesPerHour: number;
  drainToken: string;
  drainHoldMs: number;
  drainLeaseSeconds: number;
  drainBatchLimit: number;
  drainPollIntervalMs: number;
}

// Structurally identical to NodeJS.ProcessEnv, spelled out instead of named
// so this file has no dependency on the ambient @types/node globals eslint's
// plain (non-type-aware) config doesn't resolve.
export type ShimEnv = Record<string, string | undefined>;

function requireEnv(env: ShimEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveIntEnv(env: ShimEnv, name: string, fallback: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * SHIM_DB_PATH has no safe default. An unset value or ":memory:" means
 * every restart silently drops the queue, tenant keys and suppression
 * list — the exact failure mode this store exists to close. The escape
 * hatch is opt-in and named for what it is: ephemeral, not a default.
 */
export function loadConfig(env: ShimEnv = process.env): ShimConfig {
  const rawDbPath = env.SHIM_DB_PATH;
  const allowEphemeral = env.SHIM_ALLOW_EPHEMERAL_DB === 'true';
  const dbPath = rawDbPath && rawDbPath !== ':memory:' ? rawDbPath : ':memory:';

  if (dbPath === ':memory:' && !allowEphemeral) {
    throw new Error(
      'SHIM_DB_PATH is required (set SHIM_ALLOW_EPHEMERAL_DB=true to run with an ephemeral in-memory store)'
    );
  }

  const messagesPerHour = positiveIntEnv(env, 'SHIM_MESSAGES_PER_HOUR', 50);

  return {
    port: Number(env.PORT) || 8080,
    dbPath,
    throttlePath: env.SHIM_THROTTLE_PATH,
    messagesPerHour,
    // No default: an empty or guessable drain token defeats the one
    // authentication check standing between "queued mail" and "anyone who
    // can reach this port" (LLD-6 — "the drain endpoint hands out mail, so
    // it needs authentication"). requireEnv fails startup rather than let
    // the service come up silently unauthenticated.
    drainToken: requireEnv(env, 'SHIM_DRAIN_TOKEN'),
    drainHoldMs: positiveIntEnv(env, 'SHIM_DRAIN_HOLD_MS', 30_000),
    drainLeaseSeconds: positiveIntEnv(env, 'SHIM_DRAIN_LEASE_SECONDS', 30),
    drainBatchLimit: positiveIntEnv(env, 'SHIM_DRAIN_BATCH_LIMIT', 25),
    drainPollIntervalMs: positiveIntEnv(env, 'SHIM_DRAIN_POLL_INTERVAL_MS', 250),
  };
}

import type { DeliveryHostConfig } from './smtp.js';

export interface ShimConfig {
  port: number;
  dbPath: string;
  smtp: DeliveryHostConfig;
  throttlePath?: string;
  messagesPerHour: number;
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

  const messagesPerHourRaw = Number(env.SHIM_MESSAGES_PER_HOUR);
  const messagesPerHour =
    Number.isFinite(messagesPerHourRaw) && messagesPerHourRaw > 0 ? messagesPerHourRaw : 50;

  return {
    port: Number(env.PORT) || 8080,
    dbPath,
    smtp: {
      host: requireEnv(env, 'SMTP_HOST'),
      port: Number(env.SMTP_PORT) || 587,
      secure: env.SMTP_SECURE === 'true',
      auth:
        env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    },
    throttlePath: env.SHIM_THROTTLE_PATH,
    messagesPerHour,
  };
}

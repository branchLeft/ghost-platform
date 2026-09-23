import type { DeliveryHostConfig } from './smtp.js';
import { DEFAULT_ALLOWED_SOURCE_CIDRS } from './smtpFrontDoor.js';

export interface SmtpFrontDoorConfig {
  port: number;
  host: string;
  maxMessageBytes: number;
  allowedSourceCidrs: string[];
  submitterMessagesPerMinute: number;
}

export interface ShimConfig {
  port: number;
  dbPath: string;
  smtp: DeliveryHostConfig;
  throttlePath?: string;
  messagesPerHour: number;
  smtpFrontDoor: SmtpFrontDoorConfig;
}

const DEFAULT_SMTP_LISTEN_PORT = 2525;
const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_SUBMITTER_MESSAGES_PER_MINUTE = 120;

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
    smtpFrontDoor: {
      port: Number(env.SMTP_LISTEN_PORT) || DEFAULT_SMTP_LISTEN_PORT,
      // Binding every interface is normal for a containerised service — the
      // container-network-only property LLD-6 §03 requires comes from the
      // deployment not publishing this port to the host, plus the
      // source-address check in smtpFrontDoor.ts as defence in depth for it.
      host: env.SMTP_LISTEN_HOST || '0.0.0.0',
      maxMessageBytes: Number(env.SMTP_MAX_MESSAGE_BYTES) || DEFAULT_MAX_MESSAGE_BYTES,
      allowedSourceCidrs: env.SMTP_ALLOWED_SOURCE_CIDRS
        ? env.SMTP_ALLOWED_SOURCE_CIDRS.split(',').map((s) => s.trim())
        : DEFAULT_ALLOWED_SOURCE_CIDRS,
      submitterMessagesPerMinute:
        Number(env.SMTP_SUBMITTER_MESSAGES_PER_MINUTE) || DEFAULT_SUBMITTER_MESSAGES_PER_MINUTE,
    },
  };
}

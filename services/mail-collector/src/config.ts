export interface CollectorConfig {
  port: number;
  /** Directory of tenant/demo descriptor JSON files -- the only source of the drain list. */
  descriptorDir: string;
  descriptorRefreshMs: number;
  /**
   * How stale the last good descriptor refresh may be before the drain list
   * is treated as empty rather than as whatever it last held. A directory
   * outage must eventually mean nothing is drained, not that yesterday's
   * host list keeps being trusted forever -- the same reasoning odask's
   * DescriptorStore applies to the served-hostname set.
   */
  descriptorMaxStalenessMs: number;
  /**
   * The HTTP port every host's mailgun-shim listens on for its drain
   * surface. A deployment convention (every shim binds the same port,
   * distinguished by the descriptor's own `appHostIp`), not a descriptor
   * field -- render-core's TenantDescriptor carries no per-host port for
   * this because nothing renders a shim onto a host yet (see the PR body's
   * Design section).
   */
  shimPort: number;
  /**
   * The drain endpoint's bearer credential. One shared value across every
   * host today, matching the estate's current one-spool-total reality
   * (throttle.ts's own comment on the shim). Per-host tokens are the
   * shared-infra follow-on (`render_shim_env` emitting `SHIM_DRAIN_TOKEN`),
   * not this story.
   */
  drainToken: string;
  /** Client-side timeout for one GET /drain call -- must exceed the shim's own holdMs (~30s) or every long-poll would be treated as a failure. */
  drainTimeoutMs: number;
  /** How long to back off after a failed GET/POST to a target before retrying it. */
  drainRetryBackoffMs: number;
  /**
   * How long to wait before re-polling a target that answered GET /drain
   * with zero messages. The real shim already holds that request open
   * server-side for up to its own holdMs (~30s) before answering empty, so
   * this is a client-side floor against a misconfigured or misbehaving
   * target that answers immediately -- not the mechanism this collector
   * relies on to avoid hammering a well-behaved one.
   */
  emptyPollBackoffMs: number;

  /** The estate-wide egress ceiling this service now owns (moved here from the shim's per-spool bucket -- see the PR body's Design section). */
  messagesPerHour: number;
  /** Optional live-reloadable override, same `{ "messagesPerHour": N }` shape the shim's own throttle reads. */
  throttleConfigPath?: string;

  /** How long a delivered message id is remembered, so a re-offer caused by a lost ack is recognised and never redelivered. Comfortably longer than any realistic lease-lapse-and-re-offer horizon. */
  dedupeTtlMs: number;

  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };

  heartbeatUrl: string;
  heartbeatIntervalMs: number;
}

export type CollectorEnv = Record<string, string | undefined>;

function requireEnv(env: CollectorEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveIntEnv(env: CollectorEnv, name: string, fallback: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const DEFAULT_DESCRIPTOR_REFRESH_MS = 5_000;
const DEFAULT_DESCRIPTOR_MAX_STALENESS_MS = 60_000;
const DEFAULT_SHIM_PORT = 8080;
const DEFAULT_DRAIN_TIMEOUT_MS = 40_000;
const DEFAULT_DRAIN_RETRY_BACKOFF_MS = 2_000;
const DEFAULT_EMPTY_POLL_BACKOFF_MS = 250;
const DEFAULT_MESSAGES_PER_HOUR = 50;
const DEFAULT_DEDUPE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export function loadConfig(env: CollectorEnv = process.env): CollectorConfig {
  return {
    port: Number(env.PORT) || 8080,
    descriptorDir: requireEnv(env, 'COLLECTOR_DESCRIPTOR_DIR'),
    descriptorRefreshMs: positiveIntEnv(
      env,
      'COLLECTOR_DESCRIPTOR_REFRESH_MS',
      DEFAULT_DESCRIPTOR_REFRESH_MS
    ),
    descriptorMaxStalenessMs: positiveIntEnv(
      env,
      'COLLECTOR_DESCRIPTOR_MAX_STALENESS_MS',
      DEFAULT_DESCRIPTOR_MAX_STALENESS_MS
    ),
    shimPort: positiveIntEnv(env, 'COLLECTOR_SHIM_PORT', DEFAULT_SHIM_PORT),
    // No default: an empty or guessable token defeats the drain endpoint's
    // one credential check, the same reasoning as the shim's own
    // SHIM_DRAIN_TOKEN (config.ts there has no fallback either).
    drainToken: requireEnv(env, 'COLLECTOR_DRAIN_TOKEN'),
    drainTimeoutMs: positiveIntEnv(env, 'COLLECTOR_DRAIN_TIMEOUT_MS', DEFAULT_DRAIN_TIMEOUT_MS),
    drainRetryBackoffMs: positiveIntEnv(
      env,
      'COLLECTOR_DRAIN_RETRY_BACKOFF_MS',
      DEFAULT_DRAIN_RETRY_BACKOFF_MS
    ),
    emptyPollBackoffMs: positiveIntEnv(
      env,
      'COLLECTOR_EMPTY_POLL_BACKOFF_MS',
      DEFAULT_EMPTY_POLL_BACKOFF_MS
    ),
    messagesPerHour: positiveIntEnv(env, 'COLLECTOR_MESSAGES_PER_HOUR', DEFAULT_MESSAGES_PER_HOUR),
    throttleConfigPath: env.COLLECTOR_THROTTLE_CONFIG_PATH,
    dedupeTtlMs: positiveIntEnv(env, 'COLLECTOR_DEDUPE_TTL_MS', DEFAULT_DEDUPE_TTL_MS),
    smtp: {
      host: requireEnv(env, 'COLLECTOR_SMTP_HOST'),
      port: positiveIntEnv(env, 'COLLECTOR_SMTP_PORT', 587),
      secure: env.COLLECTOR_SMTP_SECURE === 'true',
      user: requireEnv(env, 'COLLECTOR_SMTP_USER'),
      pass: requireEnv(env, 'COLLECTOR_SMTP_PASS'),
    },
    heartbeatUrl: requireEnv(env, 'COLLECTOR_HEARTBEAT_URL'),
    heartbeatIntervalMs: positiveIntEnv(
      env,
      'COLLECTOR_HEARTBEAT_INTERVAL_MS',
      DEFAULT_HEARTBEAT_INTERVAL_MS
    ),
  };
}

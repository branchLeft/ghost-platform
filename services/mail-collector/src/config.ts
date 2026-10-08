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
   * The scheme every host's shim is reached on. `http` by default for a
   * local proof; the one shim actually live today answers only over TLS
   * (`https://mx1.branchleft.co.uk:8443` -- Caddy's front, per
   * shared-infra's `mail/provision/shim-compose.yml` and `Caddyfile` on
   * `origin/main`; the shim's own loopback bind is unreachable off-host).
   * See the PR body's runbook.
   */
  shimScheme: string;
  /**
   * The port every host's mailgun-shim is reached on for its drain
   * surface. A deployment convention (every shim binds the same port,
   * distinguished by the descriptor's own `appHostIp`), not a descriptor
   * field -- render-core's TenantDescriptor carries no per-host port for
   * this because nothing renders a shim onto a host yet (see the PR body's
   * Design section). Defaults to the shim's own container-internal port
   * (8080), not the TLS front's published port -- a real deployment behind
   * TLS must set this to match its front's published port explicitly.
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

  /**
   * The estate's dead-man's-switch ping URL (Healthchecks.io, or the local
   * instance standing in for it in proof). No interval config sits beside
   * this one -- the ping cadence is a side effect of the collector's own
   * poll cycle (collectorLoop.ts), never a timer this module owns; how
   * often Healthchecks itself expects to hear from that URL is a property
   * of the check configured against it there, not of this process.
   */
  heartbeatUrl: string;
  /**
   * How many CONSECUTIVE delivery failures (mx1 submissions, not drain
   * fetches) suppress the heartbeat ping. A collector that cannot submit
   * anything to mx1 -- every credential rejected, every connection refused
   * -- must not keep paging "healthy" forever just because its own liveness
   * loop is still running (LLD-8 §10b names this failure mode explicitly).
   * Reset to zero on the next successful delivery, so recovery resumes
   * paging immediately rather than waiting out a cooldown.
   */
  heartbeatFailureThreshold: number;
  /**
   * Opt-in outcome path; absent unless BOTH COLLECTOR_OUTCOMES_RETURN_PATH
   * and COLLECTOR_OUTCOMES_DSN_DIR are set (one without the other throws).
   * Absent, submissions and the drain loop are exactly as before.
   */
  outcomes?: {
    /** Envelope sender mx1 returns delivery status notifications to. */
    returnPath: string;
    /** Directory the notifications arrive in, one .eml file each. */
    dsnDir: string;
    pollMs: number;
  };
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
const DEFAULT_OUTCOMES_POLL_MS = 30_000;
const DEFAULT_SHIM_SCHEME = 'http';
const DEFAULT_HEARTBEAT_FAILURE_THRESHOLD = 5;

function shimSchemeEnv(env: CollectorEnv): string {
  const raw = env.COLLECTOR_SHIM_SCHEME;
  if (!raw) {
    return DEFAULT_SHIM_SCHEME;
  }
  if (raw !== 'http' && raw !== 'https') {
    throw new Error(`COLLECTOR_SHIM_SCHEME must be "http" or "https", got "${raw}"`);
  }
  return raw;
}

function outcomesEnv(env: CollectorEnv): CollectorConfig['outcomes'] {
  const returnPath = env.COLLECTOR_OUTCOMES_RETURN_PATH;
  const dsnDir = env.COLLECTOR_OUTCOMES_DSN_DIR;
  if (!returnPath && !dsnDir) {
    return undefined;
  }
  if (!returnPath || !dsnDir) {
    throw new Error(
      'COLLECTOR_OUTCOMES_RETURN_PATH and COLLECTOR_OUTCOMES_DSN_DIR must be set together'
    );
  }
  return {
    returnPath,
    dsnDir,
    pollMs: positiveIntEnv(env, 'COLLECTOR_OUTCOMES_POLL_MS', DEFAULT_OUTCOMES_POLL_MS),
  };
}

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
    shimScheme: shimSchemeEnv(env),
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
    heartbeatFailureThreshold: positiveIntEnv(
      env,
      'COLLECTOR_HEARTBEAT_FAILURE_THRESHOLD',
      DEFAULT_HEARTBEAT_FAILURE_THRESHOLD
    ),
    outcomes: outcomesEnv(env),
  };
}

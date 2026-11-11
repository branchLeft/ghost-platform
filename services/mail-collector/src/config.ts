import { dirname, join } from 'node:path';
import { DEFAULT_PIN_TTL_MS, MAX_CAP_HOLD_MS } from './sweegoUsage.js';

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
  /**
   * The platform's shared demo mail domain: the one domain a demo host's mail
   * may be sent from (a demo descriptor carries a local part only). Unset, the
   * mail of every demo host is held, never sent.
   */
  demoMailDomain?: string;
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
  /** The login lane's own ceiling, in messages/hour. Login mail never spends bulk tokens. */
  loginMessagesPerHour: number;
  /** Optional live-reloadable bulk ramp (see lanes.ts). Unset, bulk runs at the estate ceiling alone. */
  bulkRampPath?: string;

  /** How long a delivered message id is remembered, so a re-offer caused by a lost ack is recognised and never redelivered. Comfortably longer than any realistic lease-lapse-and-re-offer horizon. */
  dedupeTtlMs: number;

  /** File on a volume that outlives the process, holding the submitted ids. Unset, a restart forgets them and a re-offered id is submitted again. */
  dedupeStatePath?: string;

  /**
   * File the bulk deferral hold is kept in, so a restart during the hold does
   * not forget it. Defaults to a file beside `dedupeStatePath`; with neither
   * set the hold is memory-only.
   */
  bulkDeferralStatePath?: string;

  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };

  /**
   * The Sweego relay. Absent unless COLLECTOR_SWEEGO_SMTP_HOST is set. Holds
   * the path of the credential file and never the credential itself.
   */
  sweego?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    /** Root-readable file holding the relay credential. Read per message by the Sweego client. */
    passFile: string;
    /** Sweego's own send-rate ceiling, separate from `messagesPerHour`. No default: the plan sets it. */
    messagesPerHour: number;
    /** Optional live-reloadable override for the Sweego ceiling, same shape as `throttleConfigPath`. */
    throttleConfigPath?: string;
    /** Bounds connecting and every wait on the relay. */
    timeoutMs: number;
    /**
     * Messages per UTC calendar month across every tenant together, set from
     * the Sweego plan. No default: unset, Sweego is treated as not configured
     * and every message goes through mx1.
     */
    accountCap?: number;
    /** File the monthly counters are kept in, on a volume that outlives the process. Unset, Sweego is treated as not configured too. */
    usageStatePath?: string;
  };

  /** Directory the per-message target pins are kept in, on a volume that outlives the process. Unset, a restart forgets them. */
  pinStateDir?: string;
  /** How long a pin is remembered. Never below the longest Sweego cap hold (`MAX_CAP_HOLD_MS`); `loadConfig` refuses a lower value. */
  pinTtlMs: number;

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
const DEFAULT_LOGIN_MESSAGES_PER_HOUR = 3600;
const DEFAULT_DEDUPE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_OUTCOMES_POLL_MS = 30_000;
const DEFAULT_SHIM_SCHEME = 'http';
const DEFAULT_BULK_DEFERRAL_STATE_FILE = 'bulk-deferral.json';
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

/**
 * A pin that ends before the longest cap hold would let a message held at the
 * cap be decided afresh (sent to Sweego again, or to mx1), so a TTL below that
 * bound is refused at start-up rather than trusted.
 */
function pinTtlEnv(env: CollectorEnv): number {
  const ttl = positiveIntEnv(env, 'COLLECTOR_PIN_TTL_MS', DEFAULT_PIN_TTL_MS);
  if (ttl < MAX_CAP_HOLD_MS) {
    throw new Error(
      `COLLECTOR_PIN_TTL_MS is ${ttl} ms, below the longest Sweego cap hold of ${MAX_CAP_HOLD_MS} ms (31 days): a pinned message held at the cap would be decided afresh when its pin ended`
    );
  }
  return ttl;
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

function bulkDeferralStatePathEnv(env: CollectorEnv): string | undefined {
  if (env.COLLECTOR_BULK_DEFERRAL_STATE_PATH) {
    return env.COLLECTOR_BULK_DEFERRAL_STATE_PATH;
  }
  return env.COLLECTOR_DEDUPE_STATE_PATH
    ? join(dirname(env.COLLECTOR_DEDUPE_STATE_PATH), DEFAULT_BULK_DEFERRAL_STATE_FILE)
    : undefined;
}

const DEFAULT_SWEEGO_SMTP_PORT = 587;
const DEFAULT_SWEEGO_TIMEOUT_MS = 20_000;

const SWEEGO_PARTNERS = [
  'COLLECTOR_SWEEGO_SMTP_USER',
  'COLLECTOR_SWEEGO_SMTP_PASS_FILE',
  'COLLECTOR_SWEEGO_MESSAGES_PER_HOUR',
  'COLLECTOR_SWEEGO_ACCOUNT_CAP',
  'COLLECTOR_SWEEGO_USAGE_STATE_PATH',
] as const;

function accountCapEnv(env: CollectorEnv): number | undefined {
  const raw = env.COLLECTOR_SWEEGO_ACCOUNT_CAP;
  if (!raw) {
    return undefined;
  }
  const cap = Number(raw);
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error('COLLECTOR_SWEEGO_ACCOUNT_CAP must be a positive integer');
  }
  return cap;
}

/**
 * True only when the relay, the account-wide cap and the counter file are all
 * set. Any one missing and Sweego is not used at all: with no cap or nothing
 * to count in, nothing could hold the total inside the plan.
 */
export function sweegoUsable(
  sweego: CollectorConfig['sweego']
): sweego is NonNullable<CollectorConfig['sweego']> &
  Required<Pick<NonNullable<CollectorConfig['sweego']>, 'accountCap' | 'usageStatePath'>> {
  return sweego?.accountCap !== undefined && sweego.usageStatePath !== undefined;
}

function sweegoEnv(env: CollectorEnv): CollectorConfig['sweego'] {
  // The credential is a file path, never a value: refuse a value outright so
  // it cannot end up in the process environment.
  if (env.COLLECTOR_SWEEGO_SMTP_PASS !== undefined) {
    throw new Error(
      'The Sweego credential is read from a file: set COLLECTOR_SWEEGO_SMTP_PASS_FILE to its path, never the value'
    );
  }
  const host = env.COLLECTOR_SWEEGO_SMTP_HOST;
  if (!host) {
    const stray = SWEEGO_PARTNERS.find((name) => env[name]);
    if (stray) {
      throw new Error(`${stray} is set but COLLECTOR_SWEEGO_SMTP_HOST is not`);
    }
    return undefined;
  }
  const messagesPerHour = Number(requireEnv(env, 'COLLECTOR_SWEEGO_MESSAGES_PER_HOUR'));
  if (!Number.isFinite(messagesPerHour) || messagesPerHour <= 0) {
    throw new Error('COLLECTOR_SWEEGO_MESSAGES_PER_HOUR must be a positive number');
  }
  return {
    host,
    port: positiveIntEnv(env, 'COLLECTOR_SWEEGO_SMTP_PORT', DEFAULT_SWEEGO_SMTP_PORT),
    secure: env.COLLECTOR_SWEEGO_SMTP_SECURE === 'true',
    user: requireEnv(env, 'COLLECTOR_SWEEGO_SMTP_USER'),
    passFile: requireEnv(env, 'COLLECTOR_SWEEGO_SMTP_PASS_FILE'),
    messagesPerHour,
    throttleConfigPath: env.COLLECTOR_SWEEGO_THROTTLE_CONFIG_PATH || undefined,
    timeoutMs: positiveIntEnv(env, 'COLLECTOR_SWEEGO_SMTP_TIMEOUT_MS', DEFAULT_SWEEGO_TIMEOUT_MS),
    accountCap: accountCapEnv(env),
    usageStatePath: env.COLLECTOR_SWEEGO_USAGE_STATE_PATH || undefined,
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
    demoMailDomain: env.COLLECTOR_DEMO_MAIL_DOMAIN || undefined,
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
    loginMessagesPerHour: positiveIntEnv(
      env,
      'COLLECTOR_LOGIN_MESSAGES_PER_HOUR',
      DEFAULT_LOGIN_MESSAGES_PER_HOUR
    ),
    bulkRampPath: env.COLLECTOR_BULK_RAMP_PATH || undefined,
    dedupeTtlMs: positiveIntEnv(env, 'COLLECTOR_DEDUPE_TTL_MS', DEFAULT_DEDUPE_TTL_MS),
    dedupeStatePath: env.COLLECTOR_DEDUPE_STATE_PATH || undefined,
    bulkDeferralStatePath: bulkDeferralStatePathEnv(env),
    smtp: {
      host: requireEnv(env, 'COLLECTOR_SMTP_HOST'),
      port: positiveIntEnv(env, 'COLLECTOR_SMTP_PORT', 587),
      secure: env.COLLECTOR_SMTP_SECURE === 'true',
      user: requireEnv(env, 'COLLECTOR_SMTP_USER'),
      pass: requireEnv(env, 'COLLECTOR_SMTP_PASS'),
    },
    sweego: sweegoEnv(env),
    pinStateDir: env.COLLECTOR_PIN_STATE_DIR || undefined,
    pinTtlMs: pinTtlEnv(env),
    heartbeatUrl: requireEnv(env, 'COLLECTOR_HEARTBEAT_URL'),
    heartbeatFailureThreshold: positiveIntEnv(
      env,
      'COLLECTOR_HEARTBEAT_FAILURE_THRESHOLD',
      DEFAULT_HEARTBEAT_FAILURE_THRESHOLD
    ),
    outcomes: outcomesEnv(env),
  };
}

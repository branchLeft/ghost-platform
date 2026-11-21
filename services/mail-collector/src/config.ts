import { dirname, join } from 'node:path';
import { InvalidDemoCeilingError } from './invalidDemoCeilingError.js';
import {
  IP2_COUNTER_PATH_ENV,
  IP2_STATE_PATH_ENV,
  parseIp2Paths,
  type Ip2Paths,
} from './ip2Lane.js';
import {
  MX1_NL_RETURN_PATH_ENV,
  MX1_TX_RETURN_PATH_ENV,
  parseLaneReturnPaths,
  type Mx1LaneReturnPaths,
} from './mx1Lane.js';
import { MIN_MAC_KEY_LENGTH } from './outcomeId.js';
import type { MailClass } from './sendingTarget.js';
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
  /**
   * The demo mail ceilings (LLD-6 section 05), counted here so a compromised
   * demo host cannot lift them. Both count messages in a rolling window and
   * are keyed on the slot, never on an address. Each mail class has its own
   * pair: `transactional` is sign-in mail, `bulk` is newsletters.
   */
  demoCeilings: {
    /** A demo slot's own ceiling per class when its descriptor names none (`mail.ceiling`). */
    slotCeiling: Record<MailClass, number>;
    /** What every demo slot together may send in one window, per class: the hard cap they share. */
    estateCeiling: Record<MailClass, number>;
    /** The rolling window both count in. */
    windowMs: number;
    /** File the counted places are kept in, so a restart does not reset them. Defaults to a file beside `dedupeStatePath`; with neither set, a restart forgets them. */
    statePath?: string;
  };
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
    /** Messages per UTC month at which every tenant's newsletters move to mx1 while sign-in links stay. Strictly below `accountCap`. Unset, there is no separate threshold. */
    newsletterCap?: number;
    /** File the monthly counters are kept in, on a volume that outlives the process. Unset, Sweego is treated as not configured too. */
    usageStatePath?: string;
    /** File the suspension latch is kept in. Defaults to a file beside `usageStatePath`. */
    suspensionStatePath?: string;
    /** A file the owner creates to switch Sweego off for as long as it exists. Defaults to a file beside `suspensionStatePath`. */
    suspendFilePath?: string;
  };

  /** Directory the per-message target pins are kept in, on a volume that outlives the process. Unset, a restart forgets them. */
  pinStateDir?: string;
  /** How long a pin is remembered. Never below the longest Sweego cap hold (`MAX_CAP_HOLD_MS`); `loadConfig` refuses a lower value. */
  pinTtlMs: number;
  /**
   * Directory the state witnesses are kept in, on a different mount from every
   * state file above. Unset, only the markers beside the state files guard them.
   */
  stateWitnessDir?: string;

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
   * The envelope sender of every mx1 submission, by lane (see `mx1Lane.ts`).
   * Absent unless BOTH COLLECTOR_MX1_TX_RETURN_PATH and
   * COLLECTOR_MX1_NL_RETURN_PATH are set. Independent of the outcome path.
   */
  mx1Lanes?: Mx1LaneReturnPaths;
  /**
   * The second sending IP's warm-up caps: the operator-written state file and
   * the day counter. Absent unless COLLECTOR_IP2_STATE_PATH is set (the counter
   * path is then required, and so are the lane return paths: the newsletter
   * lane has no meaning without them). Absent, nothing is capped here.
   */
  ip2?: Ip2Paths;
  /**
   * Opt-in outcome path; absent unless COLLECTOR_OUTCOMES_RETURN_PATH,
   * COLLECTOR_OUTCOMES_DSN_DIR and COLLECTOR_OUTCOMES_MESSAGE_ID_KEY are all
   * set (a partial set throws). With `mx1Lanes` set, the return path is not
   * set (the lane return paths are the envelope sender), so the notification
   * directory and the Message-ID key together turn it on.
   * Absent, submissions and the drain loop are exactly as before.
   */
  /**
   * Opt-in Sweego complaint path; absent unless COLLECTOR_COMPLAINTS_URL,
   * COLLECTOR_COMPLAINTS_TOKEN_FILE and COLLECTOR_SENT_JOURNAL_PATH are all set
   * (a partial set throws), and then only beside the Sweego relay.
   */
  complaints?: ComplaintsConfig;
  outcomes?: {
    /**
     * The one envelope sender mx1 returns delivery status notifications to,
     * for every message. Absent exactly when `mx1Lanes` is set: the lane
     * return paths are then the envelope senders.
     */
    returnPath?: string;
    /** Directory the notifications arrive in, one .eml file each. */
    dsnDir: string;
    /** Signs each outgoing Message-ID (HMAC); a bounce is read only if its quoted id verifies. A secret: never logged. */
    messageIdKey: string;
    pollMs: number;
  };
}

export interface ComplaintsConfig {
  /** The receiver's private drain address. We dial it; it never dials us. */
  receiverUrl: string;
  /** Path of the file holding the receiver's drain bearer token. The value is never in config. */
  tokenFile: string;
  /** File the sent-id journal is kept in, on a volume that outlives the container. */
  sentJournalPath: string;
  sentJournalTtlMs: number;
  /** Lower-case name of the correlation header sent on every Sweego message; the receiver's `WEBHOOK_OUTCOME_HEADER` must be the same. */
  outcomeHeader: string;
  pollMs: number;
  retryBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
  perTenantPerHour: number;
  giveUpMs: number;
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
// Enough to try sign-up and a test send, no more.
const DEFAULT_DEMO_SLOT_CEILING = 20;
const DEFAULT_DEMO_ESTATE_CEILING = 100;
const DEFAULT_DEMO_CEILING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEMO_CEILING_STATE_FILE = 'demo-ceilings.json';

/** Unset or empty means the default; anything else must be digits only and above zero. */
function demoCeilingEnv(env: CollectorEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const ceiling = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(ceiling) || ceiling <= 0) {
    throw new InvalidDemoCeilingError(name);
  }
  return ceiling;
}

function demoCeilingStatePathEnv(env: CollectorEnv): string | undefined {
  if (env.COLLECTOR_DEMO_CEILING_STATE_PATH) {
    return env.COLLECTOR_DEMO_CEILING_STATE_PATH;
  }
  return env.COLLECTOR_DEDUPE_STATE_PATH
    ? join(dirname(env.COLLECTOR_DEDUPE_STATE_PATH), DEFAULT_DEMO_CEILING_STATE_FILE)
    : undefined;
}

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

function requireMessageIdKeyLength(messageIdKey: string): void {
  if (messageIdKey.length < MIN_MAC_KEY_LENGTH) {
    // The value is never put in the message.
    throw new Error(
      `COLLECTOR_OUTCOMES_MESSAGE_ID_KEY must be at least ${MIN_MAC_KEY_LENGTH} characters`
    );
  }
}

function outcomesEnv(
  env: CollectorEnv,
  mx1Lanes: Mx1LaneReturnPaths | undefined
): CollectorConfig['outcomes'] {
  const returnPath = env.COLLECTOR_OUTCOMES_RETURN_PATH;
  const dsnDir = env.COLLECTOR_OUTCOMES_DSN_DIR;
  const messageIdKey = env.COLLECTOR_OUTCOMES_MESSAGE_ID_KEY;
  if (env.COLLECTOR_OUTCOMES_BULK_RETURN_PATH) {
    throw new Error(
      `COLLECTOR_OUTCOMES_BULK_RETURN_PATH was replaced by ${MX1_NL_RETURN_PATH_ENV} and ${MX1_TX_RETURN_PATH_ENV}: unset it`
    );
  }
  if (mx1Lanes) {
    // Two settings must not name the same thing: with the lane paths set they
    // are the envelope sender of every submission.
    if (returnPath) {
      throw new Error(
        `COLLECTOR_OUTCOMES_RETURN_PATH cannot be set with ${MX1_TX_RETURN_PATH_ENV} and ${MX1_NL_RETURN_PATH_ENV}: the lane return paths are the envelope sender`
      );
    }
    if (!dsnDir && !messageIdKey) {
      return undefined;
    }
    if (!dsnDir || !messageIdKey) {
      throw new Error(
        'COLLECTOR_OUTCOMES_DSN_DIR and COLLECTOR_OUTCOMES_MESSAGE_ID_KEY must be set together'
      );
    }
    requireMessageIdKeyLength(messageIdKey);
    return {
      dsnDir,
      messageIdKey,
      pollMs: positiveIntEnv(env, 'COLLECTOR_OUTCOMES_POLL_MS', DEFAULT_OUTCOMES_POLL_MS),
    };
  }
  if (!returnPath && !dsnDir && !messageIdKey) {
    return undefined;
  }
  if (!returnPath || !dsnDir || !messageIdKey) {
    throw new Error(
      'COLLECTOR_OUTCOMES_RETURN_PATH, COLLECTOR_OUTCOMES_DSN_DIR and COLLECTOR_OUTCOMES_MESSAGE_ID_KEY must be set together'
    );
  }
  requireMessageIdKeyLength(messageIdKey);
  return {
    returnPath,
    dsnDir,
    messageIdKey,
    pollMs: positiveIntEnv(env, 'COLLECTOR_OUTCOMES_POLL_MS', DEFAULT_OUTCOMES_POLL_MS),
  };
}

function ip2Env(env: CollectorEnv, mx1Lanes: Mx1LaneReturnPaths | undefined): Ip2Paths | undefined {
  const paths = parseIp2Paths(env[IP2_STATE_PATH_ENV], env[IP2_COUNTER_PATH_ENV]);
  if (paths && !mx1Lanes) {
    // Without lane return paths nothing is told apart by lane: the caps would
    // count mail that does not leave from the second IP.
    throw new Error(
      `${IP2_STATE_PATH_ENV} needs ${MX1_TX_RETURN_PATH_ENV} and ${MX1_NL_RETURN_PATH_ENV}: the newsletter lane is the envelope sender's domain`
    );
  }
  return paths;
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
  'COLLECTOR_SWEEGO_NEWSLETTER_CAP',
  'COLLECTOR_SWEEGO_SUSPENSION_STATE_PATH',
  'COLLECTOR_SWEEGO_SUSPEND_FILE_PATH',
] as const;

const DEFAULT_SUSPENSION_STATE_FILE = 'sweego-suspension.json';
const DEFAULT_SUSPEND_FILE = 'sweego-suspend';

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

/** Unset means no separate threshold. Set, it must sit strictly below the account cap, which must itself be set. */
function newsletterCapEnv(env: CollectorEnv, accountCap: number | undefined): number | undefined {
  const raw = env.COLLECTOR_SWEEGO_NEWSLETTER_CAP;
  if (!raw) {
    return undefined;
  }
  const cap = Number(raw);
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error('COLLECTOR_SWEEGO_NEWSLETTER_CAP must be a positive integer');
  }
  if (accountCap === undefined) {
    throw new Error(
      'COLLECTOR_SWEEGO_NEWSLETTER_CAP is set but COLLECTOR_SWEEGO_ACCOUNT_CAP is not'
    );
  }
  if (cap >= accountCap) {
    throw new Error(
      'COLLECTOR_SWEEGO_NEWSLETTER_CAP must be strictly below COLLECTOR_SWEEGO_ACCOUNT_CAP'
    );
  }
  return cap;
}

/** The suspension files default to a place beside the counter file, so one volume carries all Sweego state. */
function besideUsage(usageStatePath: string | undefined, name: string): string | undefined {
  return usageStatePath ? join(dirname(usageStatePath), name) : undefined;
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
  const accountCap = accountCapEnv(env);
  const usageStatePath = env.COLLECTOR_SWEEGO_USAGE_STATE_PATH || undefined;
  const suspensionStatePath =
    env.COLLECTOR_SWEEGO_SUSPENSION_STATE_PATH ||
    besideUsage(usageStatePath, DEFAULT_SUSPENSION_STATE_FILE);
  return {
    host,
    port: positiveIntEnv(env, 'COLLECTOR_SWEEGO_SMTP_PORT', DEFAULT_SWEEGO_SMTP_PORT),
    secure: env.COLLECTOR_SWEEGO_SMTP_SECURE === 'true',
    user: requireEnv(env, 'COLLECTOR_SWEEGO_SMTP_USER'),
    passFile: requireEnv(env, 'COLLECTOR_SWEEGO_SMTP_PASS_FILE'),
    messagesPerHour,
    throttleConfigPath: env.COLLECTOR_SWEEGO_THROTTLE_CONFIG_PATH || undefined,
    timeoutMs: positiveIntEnv(env, 'COLLECTOR_SWEEGO_SMTP_TIMEOUT_MS', DEFAULT_SWEEGO_TIMEOUT_MS),
    accountCap,
    newsletterCap: newsletterCapEnv(env, accountCap),
    usageStatePath,
    suspensionStatePath,
    suspendFilePath:
      env.COLLECTOR_SWEEGO_SUSPEND_FILE_PATH ||
      (suspensionStatePath ? join(dirname(suspensionStatePath), DEFAULT_SUSPEND_FILE) : undefined),
  };
}

const COMPLAINTS_PARTNERS = [
  'COLLECTOR_COMPLAINTS_URL',
  'COLLECTOR_COMPLAINTS_TOKEN_FILE',
  'COLLECTOR_SENT_JOURNAL_PATH',
] as const;
const DEFAULT_COMPLAINTS_POLL_MS = 30_000;
const DEFAULT_COMPLAINTS_RETRY_BACKOFF_MS = 5_000;
const DEFAULT_COMPLAINTS_MAX_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_COMPLAINTS_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLAINTS_PER_TENANT_PER_HOUR = 50;
const DEFAULT_COMPLAINTS_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SENT_JOURNAL_TTL_MS = 35 * 24 * 60 * 60 * 1000;
const DEFAULT_OUTCOME_HEADER = 'x-branchleft-outcome';
const HEADER_NAME = /^[a-z][a-z0-9-]{0,62}$/;

function complaintsEnv(env: CollectorEnv): ComplaintsConfig | undefined {
  const [url, tokenFile, journalPath] = COMPLAINTS_PARTNERS.map((name) => env[name]);
  if (!url && !tokenFile && !journalPath) {
    return undefined;
  }
  if (!url || !tokenFile || !journalPath) {
    throw new Error(`${COMPLAINTS_PARTNERS.join(', ')} must be set together`);
  }
  if (env.COLLECTOR_COMPLAINTS_TOKEN !== undefined) {
    throw new Error(
      'The receiver token is read from a file: set COLLECTOR_COMPLAINTS_TOKEN_FILE to its path, never the value'
    );
  }
  if (!env.COLLECTOR_SWEEGO_SMTP_HOST) {
    throw new Error('COLLECTOR_COMPLAINTS_URL is set but COLLECTOR_SWEEGO_SMTP_HOST is not');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('COLLECTOR_COMPLAINTS_URL is not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('COLLECTOR_COMPLAINTS_URL must be http or https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('COLLECTOR_COMPLAINTS_URL must not carry credentials');
  }
  const outcomeHeader = (
    env.COLLECTOR_COMPLAINTS_OUTCOME_HEADER || DEFAULT_OUTCOME_HEADER
  ).toLowerCase();
  if (!HEADER_NAME.test(outcomeHeader)) {
    throw new Error('COLLECTOR_COMPLAINTS_OUTCOME_HEADER is not a header name');
  }
  return {
    receiverUrl: url.replace(/\/+$/, ''),
    tokenFile,
    sentJournalPath: journalPath,
    sentJournalTtlMs: positiveIntEnv(
      env,
      'COLLECTOR_SENT_JOURNAL_TTL_MS',
      DEFAULT_SENT_JOURNAL_TTL_MS
    ),
    outcomeHeader,
    pollMs: positiveIntEnv(env, 'COLLECTOR_COMPLAINTS_POLL_MS', DEFAULT_COMPLAINTS_POLL_MS),
    retryBackoffMs: positiveIntEnv(
      env,
      'COLLECTOR_COMPLAINTS_RETRY_BACKOFF_MS',
      DEFAULT_COMPLAINTS_RETRY_BACKOFF_MS
    ),
    maxBackoffMs: positiveIntEnv(
      env,
      'COLLECTOR_COMPLAINTS_MAX_BACKOFF_MS',
      DEFAULT_COMPLAINTS_MAX_BACKOFF_MS
    ),
    timeoutMs: positiveIntEnv(
      env,
      'COLLECTOR_COMPLAINTS_TIMEOUT_MS',
      DEFAULT_COMPLAINTS_TIMEOUT_MS
    ),
    perTenantPerHour: positiveIntEnv(
      env,
      'COLLECTOR_COMPLAINTS_PER_TENANT_PER_HOUR',
      DEFAULT_COMPLAINTS_PER_TENANT_PER_HOUR
    ),
    giveUpMs: positiveIntEnv(env, 'COLLECTOR_COMPLAINTS_GIVE_UP_MS', DEFAULT_COMPLAINTS_GIVE_UP_MS),
  };
}

export function loadConfig(env: CollectorEnv = process.env): CollectorConfig {
  const mx1Lanes = parseLaneReturnPaths(env[MX1_TX_RETURN_PATH_ENV], env[MX1_NL_RETURN_PATH_ENV]);
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
    demoCeilings: {
      slotCeiling: {
        transactional: demoCeilingEnv(
          env,
          'COLLECTOR_DEMO_SLOT_TRANSACTIONAL_CEILING',
          DEFAULT_DEMO_SLOT_CEILING
        ),
        bulk: demoCeilingEnv(env, 'COLLECTOR_DEMO_SLOT_BULK_CEILING', DEFAULT_DEMO_SLOT_CEILING),
      },
      estateCeiling: {
        transactional: demoCeilingEnv(
          env,
          'COLLECTOR_DEMO_ESTATE_TRANSACTIONAL_CEILING',
          DEFAULT_DEMO_ESTATE_CEILING
        ),
        bulk: demoCeilingEnv(
          env,
          'COLLECTOR_DEMO_ESTATE_BULK_CEILING',
          DEFAULT_DEMO_ESTATE_CEILING
        ),
      },
      windowMs: positiveIntEnv(
        env,
        'COLLECTOR_DEMO_CEILING_WINDOW_MS',
        DEFAULT_DEMO_CEILING_WINDOW_MS
      ),
      statePath: demoCeilingStatePathEnv(env),
    },
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
    stateWitnessDir: env.COLLECTOR_STATE_WITNESS_DIR || undefined,
    heartbeatUrl: requireEnv(env, 'COLLECTOR_HEARTBEAT_URL'),
    heartbeatFailureThreshold: positiveIntEnv(
      env,
      'COLLECTOR_HEARTBEAT_FAILURE_THRESHOLD',
      DEFAULT_HEARTBEAT_FAILURE_THRESHOLD
    ),
    mx1Lanes,
    ip2: ip2Env(env, mx1Lanes),
    outcomes: outcomesEnv(env, mx1Lanes),
    complaints: complaintsEnv(env),
  };
}

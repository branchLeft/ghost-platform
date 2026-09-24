import { DEFAULT_ALLOWED_SOURCE_CIDRS } from './smtpFrontDoor.js';

export interface SmtpFrontDoorConfig {
  port: number;
  host: string;
  maxMessageBytes: number;
  maxUnauthenticatedConnectionsPerSource: number;
  maxUnauthenticatedConnections: number;
  maxUnauthenticatedPerSourceWaitQueueDepth: number;
  maxUnauthenticatedPerSourceWaitMs: number;
  authDeadlineMs: number;
  maxConcurrentDataPhases: number;
  maxConcurrentDataPhasesPerSubmitter: number;
  allowedSourceCidrs: string[];
  submitterMessagesPerMinute: number;
}

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
  // The SMTP front door's RCPT cap only. Ghost's SMTP transactional sender
  // (magic links, password resets, staff invites) addresses exactly one
  // recipient per message (LLD-6), so this bounds that channel alone — the
  // HTTP Mailgun-shaped route below carries Ghost's bulk newsletter sends
  // in batches of up to 1,000 (Ghost's own DEFAULT_BATCH_SIZE) and has no
  // recipient cap of its own.
  maxRecipientsPerMessage: number;
  smtpFrontDoor: SmtpFrontDoorConfig;
}

// Docker sets `ip_unprivileged_port_start=0` in each container's network
// namespace, so this service's unprivileged runtime user can bind :25
// directly with no added capability.
const DEFAULT_SMTP_LISTEN_PORT = 25;

// Ghost's transactional sender (magic links, password resets, staff
// invites) is plain HTML/text template mail, typically tens of KB — 2 MiB
// is generous headroom, not a fit to any real message this listener should
// ever see. Sized together with maxConcurrentDataPhases below: the two
// bound this listener's worst-case retained memory as a product, not
// independently.
const DEFAULT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

// A generous global backstop bounding the unauthenticated pool in
// aggregate, in case several distinct sources are legitimately connecting
// at once. Should never be the binding limit for a single well-behaved
// source — the per-source cap below is sized to bind first, well before
// this one could.
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS = 100;

// Bounds one source address's own share of the unauthenticated pool that is
// admitted WITHOUT waiting, checked before the global backstop above. A
// credential-less peer holding (or churning — replacing each connection the
// instant it's refused or evicted) idle connections can never occupy more
// than this many instantly, however many it opens: churn defeats a purely
// time-based deadline (reconnect faster than it expires) and a purely
// global count-based cap doesn't need many addresses to exhaust. A single
// legitimate Ghost source is not always at 0 or 1 concurrent connections —
// several members signing in at once each open their own connection, and
// scrypt's own per-AUTH cost means more than a few can be simultaneously
// unauthenticated for real — so a burst past this cap waits rather than
// being refused; see the two settings below.
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE = 5;

// How many connections from one source can be queued at once waiting for a
// per-source slot, once that source is past the cap above. Bounds the
// queue's own memory (each entry is a still-open, unauthenticated socket
// plus a closure — negligible individually, but not unbounded); a burst
// past this depth is refused outright rather than queued further. Sized
// well past any single legitimate host's realistic simultaneous sign-in
// count.
const DEFAULT_MAX_UNAUTHENTICATED_PER_SOURCE_WAIT_QUEUE_DEPTH = 50;

// How long a queued connection waits for its own source's slot to free
// before being refused outright. scrypt's own AUTH check runs at roughly
// 20ms — even a full queue at the depth above clears in about a second in
// the worst case — so this is sized for large headroom under nodemailer's
// own ~30s greeting timeout, not to match the expected wait.
const DEFAULT_MAX_UNAUTHENTICATED_PER_SOURCE_WAIT_MS = 5000;

// How long a connection has to complete AUTH before it is closed outright.
// Short enough that holding a slot open with no credential is not a viable
// way to deny service, long enough that a legitimate client's own EHLO/AUTH
// round trip on the container network never comes close.
const DEFAULT_AUTH_DEADLINE_MS = 5000;

// What actually costs memory is a DATA phase in flight (bytes accumulating
// up to maxMessageBytes), not merely being connected or authenticated — an
// idle authenticated connection retains nothing. Total retained memory is
// therefore bounded as maxConcurrentDataPhases * maxMessageBytes. 20
// concurrent transactional sends across every submitter combined is well
// past anything one Ghost instance on a single host produces in practice.
const DEFAULT_MAX_CONCURRENT_DATA_PHASES = 20;

// Stops one credential claiming the whole global budget above; lower than
// the global cap so a single submitter never occupies more than a fraction
// of it even at its own ceiling.
const DEFAULT_MAX_CONCURRENT_DATA_PHASES_PER_SUBMITTER = 5;

const DEFAULT_SUBMITTER_MESSAGES_PER_MINUTE = 120;

// Ghost's SMTP transactional sender always addresses exactly one recipient
// per message (LLD-6 §03) — 50 is generous headroom above that, not a fit
// to any real send this listener should ever see, and bounds one
// credential's envelope fan-out per message. smtp-server rescans its whole
// rcptTo array on every RCPT, so an unbounded envelope costs quadratic CPU
// on this connection and starves every other submitter sharing the process
// while it runs. A message over the cap is refused mid-envelope with a
// temporary failure (RFC 5321), never trimmed and accepted: trimming would
// return a false success for the recipients silently dropped. This is the
// SMTP front door's own cap — the HTTP Mailgun-shaped route carries
// Ghost's bulk newsletter sends and has no recipient cap of its own.
const DEFAULT_MAX_RECIPIENTS_PER_MESSAGE = 50;

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
    maxRecipientsPerMessage:
      Number(env.SHIM_MAX_RECIPIENTS_PER_MESSAGE) || DEFAULT_MAX_RECIPIENTS_PER_MESSAGE,
    smtpFrontDoor: {
      port: Number(env.SMTP_LISTEN_PORT) || DEFAULT_SMTP_LISTEN_PORT,
      // Binding every interface is normal for a containerised service —
      // staying off the host network is a deployment property (the port
      // must never be published), not something this bind address controls.
      host: env.SMTP_LISTEN_HOST || '0.0.0.0',
      maxMessageBytes: Number(env.SMTP_MAX_MESSAGE_BYTES) || DEFAULT_MAX_MESSAGE_BYTES,
      maxUnauthenticatedConnectionsPerSource:
        Number(env.SMTP_MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE) ||
        DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE,
      maxUnauthenticatedConnections:
        Number(env.SMTP_MAX_UNAUTHENTICATED_CONNECTIONS) || DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS,
      maxUnauthenticatedPerSourceWaitQueueDepth:
        Number(env.SMTP_MAX_UNAUTHENTICATED_PER_SOURCE_WAIT_QUEUE_DEPTH) ||
        DEFAULT_MAX_UNAUTHENTICATED_PER_SOURCE_WAIT_QUEUE_DEPTH,
      maxUnauthenticatedPerSourceWaitMs:
        Number(env.SMTP_MAX_UNAUTHENTICATED_PER_SOURCE_WAIT_MS) ||
        DEFAULT_MAX_UNAUTHENTICATED_PER_SOURCE_WAIT_MS,
      authDeadlineMs: Number(env.SMTP_AUTH_DEADLINE_MS) || DEFAULT_AUTH_DEADLINE_MS,
      maxConcurrentDataPhases:
        Number(env.SMTP_MAX_CONCURRENT_DATA_PHASES) || DEFAULT_MAX_CONCURRENT_DATA_PHASES,
      maxConcurrentDataPhasesPerSubmitter:
        Number(env.SMTP_MAX_CONCURRENT_DATA_PHASES_PER_SUBMITTER) ||
        DEFAULT_MAX_CONCURRENT_DATA_PHASES_PER_SUBMITTER,
      allowedSourceCidrs: env.SMTP_ALLOWED_SOURCE_CIDRS
        ? env.SMTP_ALLOWED_SOURCE_CIDRS.split(',').map((s) => s.trim())
        : DEFAULT_ALLOWED_SOURCE_CIDRS,
      submitterMessagesPerMinute:
        Number(env.SMTP_SUBMITTER_MESSAGES_PER_MINUTE) || DEFAULT_SUBMITTER_MESSAGES_PER_MINUTE,
    },
  };
}

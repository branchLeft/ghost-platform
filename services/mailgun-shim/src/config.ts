import type { DeliveryHostConfig } from './smtp.js';
import { DEFAULT_ALLOWED_SOURCE_CIDRS } from './smtpFrontDoor.js';

export interface SmtpFrontDoorConfig {
  port: number;
  host: string;
  maxMessageBytes: number;
  maxUnauthenticatedConnectionsPerSource: number;
  maxUnauthenticatedConnections: number;
  authDeadlineMs: number;
  maxConcurrentDataPhases: number;
  maxConcurrentDataPhasesPerSubmitter: number;
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

// Bounds one source address's own share of the unauthenticated pool,
// checked before the global backstop above. A credential-less peer holding
// (or churning — replacing each connection the instant it's refused or
// evicted) idle connections can never occupy more than this many, however
// many it opens: churn defeats a purely time-based deadline (reconnect
// faster than it expires) and a purely global count-based cap doesn't need
// many addresses to exhaust. Each legitimate source is exactly one Ghost
// container, so this never binds for a well-behaved single source — its
// own concurrent connection count in practice is 0 or 1.
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE = 5;

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

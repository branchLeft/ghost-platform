import { readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import type { WireMessage } from './drainClient.js';
import type { Logger } from './log.js';

/**
 * Two lanes share the drain loop. Login (transactional) mail is a wire
 * message with no emailId; bulk (campaign) mail carries one. This is the
 * same rule the shim applies when it writes X-Ghost-Email-Id.
 */
export type Lane = 'login' | 'bulk';

export function laneOf(message: Pick<WireMessage, 'emailId'>): Lane {
  return message.emailId ? 'bulk' : 'login';
}

const GOOGLE_UNUSUAL_RATE = /^4\d\d[ -]4\.7\.28(?![\d.])/;
const MICROSOFT_THROTTLE = /^451[ -]4\.7\.650(?![\d.])/;

/**
 * A receiving-side "slow down" reply, matched on the SMTP text a submission
 * returned: Google's 4.7.28 unusual-rate reply, or 451 4.7.650 (Microsoft's
 * reputation throttle). The enhanced code counts only at the status code
 * position, right after a reply line's three-digit code, so the same digits
 * inside an address, a URL or a reference number never slow the lane. The
 * collector only sees mx1's own replies, so this fires only when mx1 hands
 * one back; receiver deferrals in mx1's queue are not visible here.
 */
export function isBulkDeferral(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { response, message } = error as { response?: unknown; message?: unknown };
  // The server's reply is read from line start. Only when the error carries no
  // reply text is the error message read, with one client prefix allowed first.
  const lines =
    typeof response === 'string'
      ? response.split(/\r?\n/)
      : typeof message === 'string'
        ? message.split(/\r?\n/).flatMap((line) => [line, line.replace(/^[^:]*: /, '')])
        : [];
  return lines.some((line) => GOOGLE_UNUSUAL_RATE.test(line) || MICROSOFT_THROTTLE.test(line));
}

export interface RampStep {
  readonly afterDays: number;
  readonly messagesPerHour: number;
}

export interface RampSchedule {
  readonly startedAt: string;
  readonly steps: readonly RampStep[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead of the collector's clock a startedAt may sit before it is refused as a typo, not as skew. */
const MAX_START_SKEW_MS = 5 * 60 * 1000;
/** A ramp that began longer ago than this is not a warm-up: refuse the file rather than jump to its last step. */
export const MAX_RAMP_AGE_DAYS = 366;

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** The instant an ISO-8601 string names, or undefined unless it is a complete, real date and time with a zone. Date.parse alone also accepts '11' and '2020'. */
function parseIsoInstant(value: string): number | undefined {
  const m = ISO_INSTANT.exec(value);
  if (!m) {
    return undefined;
  }
  const [year, month, day, hour, minute, second = 0, offH = 0, offM = 0] = m
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part))) as number[];
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month! - 1 ||
    calendar.getUTCDate() !== day ||
    hour! > 23 ||
    minute! > 59 ||
    second > 59 ||
    offH > 23 ||
    offM > 59
  ) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Validates the ramp file's shape. Throws on anything it cannot read as an
 * exact schedule: a ramp that is only half understood must not run.
 */
export function parseRampSchedule(raw: unknown, nowMs: number = Date.now()): RampSchedule {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('ramp file must be a JSON object');
  }
  const { startedAt, steps } = raw as Record<string, unknown>;
  const startedMs = typeof startedAt === 'string' ? parseIsoInstant(startedAt) : undefined;
  if (typeof startedAt !== 'string' || startedMs === undefined) {
    throw new Error('startedAt must be an ISO-8601 instant with a date, a time and a zone');
  }
  if (startedMs > nowMs + MAX_START_SKEW_MS) {
    throw new Error('startedAt must not be in the future');
  }
  if (startedMs < nowMs - MAX_RAMP_AGE_DAYS * DAY_MS) {
    throw new Error(`startedAt is older than ${MAX_RAMP_AGE_DAYS} days`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }
  const parsed: RampStep[] = steps.map((step: unknown) => {
    const { afterDays, messagesPerHour } = (step ?? {}) as Record<string, unknown>;
    if (typeof afterDays !== 'number' || !Number.isInteger(afterDays) || afterDays < 0) {
      throw new Error('each step needs an integer afterDays of 0 or more');
    }
    if (
      typeof messagesPerHour !== 'number' ||
      !Number.isInteger(messagesPerHour) ||
      messagesPerHour < 1
    ) {
      throw new Error('each step needs an integer messagesPerHour of 1 or more');
    }
    return { afterDays, messagesPerHour };
  });
  if (parsed[0]!.afterDays !== 0) {
    throw new Error('the first step must start at afterDays 0');
  }
  for (let i = 1; i < parsed.length; i += 1) {
    if (parsed[i]!.afterDays <= parsed[i - 1]!.afterDays) {
      throw new Error('steps must be in strictly ascending afterDays order');
    }
  }
  return { startedAt, steps: parsed };
}

/** The rate the schedule sets at `nowMs`: the last step whose afterDays has passed. Before startedAt, the first step. */
export function rampRateAt(schedule: RampSchedule, nowMs: number): number {
  const elapsedDays = (nowMs - Date.parse(schedule.startedAt)) / DAY_MS;
  let rate = schedule.steps[0]!.messagesPerHour;
  for (const step of schedule.steps) {
    if (elapsedDays >= step.afterDays) {
      rate = step.messagesPerHour;
    }
  }
  return rate;
}

export const DEFAULT_DEFERRAL_HOLD_MS = 10 * 60 * 1000;

/** The rate a configured ramp file gives while the file is missing or has never parsed: slow, never fast. Late, not lost. */
const UNREADABLE_RAMP_PER_HOUR = 1;

export interface BulkCapOptions {
  /** Optional live-reloadable ramp file. Unset, bulk runs at the estate ceiling alone. */
  rampPath?: string;
  /** How long a deferral holds the reduced rate. Google asks for at least 10 minutes. */
  deferralHoldMs?: number;
  log?: Logger;
  now?: () => number;
  /**
   * File the deferral hold is kept in, on a volume that outlives the process,
   * so a restart during the hold does not forget it. Unset, the hold is memory-only.
   */
  deferralStatePath?: string;
  /** Called with a state-file read or write failure; the cap never throws for one. */
  onStateError?: (error: Error) => void;
}

export interface BulkCap {
  /** The effective bulk rate at `nowMs`, given the configured ceiling. Never below 1 per hour. */
  rateFor(configuredPerHour: number, nowMs: number): number;
  /** Halves the rate for the hold period. A deferral inside an active hold halves it again. */
  recordDeferral(): void;
}

const DEFERRAL_STATE_VERSION = 1;

export function createBulkCap(opts: BulkCapOptions = {}): BulkCap {
  const now = opts.now ?? Date.now;
  const holdMs = opts.deferralHoldMs ?? DEFAULT_DEFERRAL_HOLD_MS;
  const statePath = opts.deferralStatePath;
  let schedule: RampSchedule | undefined;
  let lastMtimeMs: number | undefined;
  let halvings = 0;
  let reducedUntilMs = 0;

  function reportStateError(error: unknown): void {
    opts.onStateError?.(error instanceof Error ? error : new Error(String(error)));
  }

  function persistDeferral(path: string): void {
    try {
      writeFileAtomic(
        path,
        JSON.stringify({ version: DEFERRAL_STATE_VERSION, halvings, reducedUntilMs })
      );
    } catch (error) {
      reportStateError(error);
    }
  }

  // A missing file is no hold. A file that is there but cannot be trusted is a
  // fresh hold: slow for one hold period, never the full rate on a guess.
  function loadDeferral(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return;
      }
      reportStateError(error);
      startFreshHold(path);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        halvings?: unknown;
        reducedUntilMs?: unknown;
      };
      if (
        parsed.version !== DEFERRAL_STATE_VERSION ||
        typeof parsed.halvings !== 'number' ||
        !Number.isInteger(parsed.halvings) ||
        parsed.halvings < 1 ||
        typeof parsed.reducedUntilMs !== 'number' ||
        !Number.isFinite(parsed.reducedUntilMs)
      ) {
        throw new Error('bulk deferral state file has an unrecognised shape');
      }
      // A hold never lasts longer than one period from now, whatever the file says.
      reducedUntilMs = Math.min(parsed.reducedUntilMs, now() + holdMs);
      halvings = parsed.halvings;
    } catch (error) {
      reportStateError(error);
      startFreshHold(path);
    }
  }

  function startFreshHold(path: string): void {
    halvings = 1;
    reducedUntilMs = now() + holdMs;
    persistDeferral(path);
  }

  if (statePath) {
    loadDeferral(statePath);
  }

  function reloadRamp(): void {
    if (opts.rampPath === undefined) {
      return;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(opts.rampPath).mtimeMs;
    } catch {
      // Missing: keep the last good schedule. With none ever loaded,
      // rateFor() answers the slow unreadable rate.
      return;
    }
    if (mtimeMs === lastMtimeMs) {
      return;
    }
    lastMtimeMs = mtimeMs;
    try {
      schedule = parseRampSchedule(JSON.parse(readFileSync(opts.rampPath, 'utf8')), now());
    } catch (error) {
      opts.log?.warn('bulk_ramp_invalid', { error: (error as Error).message });
    }
  }

  return {
    rateFor(configuredPerHour: number, nowMs: number): number {
      reloadRamp();
      if (nowMs >= reducedUntilMs) {
        halvings = 0;
      }
      let base = configuredPerHour;
      if (opts.rampPath !== undefined) {
        base = Math.min(base, schedule ? rampRateAt(schedule, nowMs) : UNREADABLE_RAMP_PER_HOUR);
      }
      return Math.max(1, Math.floor(base / 2 ** halvings));
    },
    recordDeferral(): void {
      const nowMs = now();
      halvings = nowMs < reducedUntilMs ? halvings + 1 : 1;
      reducedUntilMs = nowMs + holdMs;
      if (statePath) {
        persistDeferral(statePath);
      }
    },
  };
}

import { readFileSync, statSync } from 'node:fs';
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

/**
 * A receiving-side "slow down" reply, matched on the SMTP text a submission
 * returned: Google's 4.7.28 unusual-rate reply, or 451 4.7.650 (Microsoft's
 * reputation throttle). The collector only sees mx1's own replies, so this
 * fires only when mx1 hands one back; receiver deferrals in mx1's queue are
 * not visible here.
 */
export function isBulkDeferral(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { response, responseCode, message } = error as {
    response?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  const text = [response, message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  if (/\b4\.7\.28\b/.test(text)) {
    return true;
  }
  return responseCode === 451 && /\b4\.7\.650\b/.test(text);
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

/**
 * Validates the ramp file's shape. Throws on anything it cannot read as an
 * exact schedule: a ramp that is only half understood must not run.
 */
export function parseRampSchedule(raw: unknown): RampSchedule {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('ramp file must be a JSON object');
  }
  const { startedAt, steps } = raw as Record<string, unknown>;
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) {
    throw new Error('startedAt must be an ISO-8601 time');
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
}

export interface BulkCap {
  /** The effective bulk rate at `nowMs`, given the configured ceiling. Never below 1 per hour. */
  rateFor(configuredPerHour: number, nowMs: number): number;
  /** Halves the rate for the hold period. A deferral inside an active hold halves it again. */
  recordDeferral(): void;
}

export function createBulkCap(opts: BulkCapOptions = {}): BulkCap {
  const now = opts.now ?? Date.now;
  const holdMs = opts.deferralHoldMs ?? DEFAULT_DEFERRAL_HOLD_MS;
  let schedule: RampSchedule | undefined;
  let lastMtimeMs: number | undefined;
  let halvings = 0;
  let reducedUntilMs = 0;

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
      schedule = parseRampSchedule(JSON.parse(readFileSync(opts.rampPath, 'utf8')));
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
    },
  };
}

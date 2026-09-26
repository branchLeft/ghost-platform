import { readFileSync, statSync } from 'node:fs';
import type { Logger } from './log.js';

export interface ThrottleOptions {
  /** Re-read on mtime change (see reload()) -- takes precedence over messagesPerHour when present. */
  configPath?: string;
  messagesPerHour: number;
  now?: () => number;
  log?: Logger;
}

export interface Throttle {
  /** Consumes one token if available. Never blocks. */
  tryTake(): boolean;
  /** Resolves once a token is available, having consumed it. Rejects if `signal` aborts first. */
  waitForToken(signal?: AbortSignal): Promise<void>;
  /** Re-reads configPath if its mtime changed since the last reload; a no-op otherwise. */
  reload(): void;
  currentRate(): number;
}

const DEFAULT_MESSAGES_PER_HOUR = 50;
const SECONDS_PER_HOUR = 3600;
const POLL_INTERVAL_MS = 250;

/**
 * The estate-wide token bucket, in messages/hour. This is the shim's own
 * per-spool bucket (`services/mailgun-shim/src/throttle.ts`), relocated
 * rather than copied by import: that module's own comment documents why it
 * has to move once every host gets its own spool (LLD-6's end state) --
 * N spools each independently allowed up to `messagesPerHour` is N times
 * the intended rate against the one address that carries mx1's sending
 * reputation. This collector is the single egress point every spool's mail
 * converges on, so it is the one place left that can still bound the real
 * rate; the shim's bucket stays where it is, gating how much any one spool
 * can hand over in a single drain, never the estate total.
 *
 * Starts with exactly ONE grace token, not a full bucket and not zero, for
 * the same reason the shim's own bucket does: zero would make the very
 * first message this process ever forwards wait out a full 1/messagesPerHour
 * hour before anything has actually burst, breaking this story's own "within
 * a second of enqueue" cold-start criterion for no protective reason; a full
 * bucket would let a freshly restarted collector burst up to the hourly cap
 * immediately, defeating the point of a ceiling that exists to protect mx1's
 * IP reputation across restarts, not just within one process lifetime.
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  const now = opts.now ?? (() => Date.now() / 1000);
  let messagesPerHour = opts.messagesPerHour > 0 ? opts.messagesPerHour : DEFAULT_MESSAGES_PER_HOUR;
  let tokens = Math.min(1, messagesPerHour);
  let lastRefillAt = now();
  let lastMtimeMs: number | undefined;

  function refill(): void {
    const nowSeconds = now();
    const elapsedHours = (nowSeconds - lastRefillAt) / SECONDS_PER_HOUR;
    if (elapsedHours > 0) {
      tokens = Math.min(messagesPerHour, tokens + elapsedHours * messagesPerHour);
      lastRefillAt = nowSeconds;
    }
  }

  function tryTake(): boolean {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  }

  function reload(): void {
    if (!opts.configPath) {
      return;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(opts.configPath).mtimeMs;
    } catch {
      // Missing file -- keep the previously effective rate rather than
      // falling back to the constructor value, which would look like a
      // silent rate change on every operator typo in the path.
      return;
    }
    if (mtimeMs === lastMtimeMs) {
      return;
    }
    lastMtimeMs = mtimeMs;
    try {
      const raw = JSON.parse(readFileSync(opts.configPath, 'utf8')) as {
        messagesPerHour?: unknown;
      };
      if (typeof raw.messagesPerHour === 'number' && raw.messagesPerHour > 0) {
        if (raw.messagesPerHour !== messagesPerHour) {
          opts.log?.info('throttle_reload', {
            previousRate: messagesPerHour,
            newRate: raw.messagesPerHour,
          });
        }
        messagesPerHour = raw.messagesPerHour;
      }
    } catch {
      // Malformed JSON -- keep the previously effective rate.
    }
  }

  return {
    tryTake,
    reload,
    currentRate() {
      return messagesPerHour;
    },
    waitForToken(signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const attempt = (): void => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('waitForToken aborted'));
            return;
          }
          reload();
          if (tryTake()) {
            resolve();
            return;
          }
          const timer = setTimeout(attempt, POLL_INTERVAL_MS);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason ?? new Error('waitForToken aborted'));
            },
            { once: true }
          );
        };
        attempt();
      });
    },
  };
}

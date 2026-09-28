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
 * The estate-wide token bucket, in messages/hour -- the shim's own
 * per-spool bucket relocated here because this collector is the single
 * egress point every spool's mail converges on. Starts with exactly one
 * grace token, not a full bucket and not zero, so the first message
 * forwarded after a restart neither waits out a full period nor lets a
 * restart burst up to the hourly cap.
 * See ../README.md#throttle-token-bucket.
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

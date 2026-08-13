import { readFileSync, statSync } from 'node:fs';
import type { Logger } from './log.js';

export interface ThrottleOptions {
  /** Re-read on mtime change (see reload()) — takes precedence over envMessagesPerHour when present. */
  configPath?: string;
  envMessagesPerHour: number;
  now?: () => number;
  log?: Logger;
}

export interface Throttle {
  /** Consumes one token if available. Never blocks — a caller with no token waits for a later call. */
  tryTake(): boolean;
  /** Re-reads configPath if its mtime changed since the last reload; a no-op otherwise. */
  reload(): void;
  currentRate(): number;
}

const DEFAULT_MESSAGES_PER_HOUR = 50;
const SECONDS_PER_HOUR = 3600;

/**
 * Token bucket in messages/hour. Starts empty (not full) on purpose: this
 * gates warm-up sending, so a freshly started worker must not be allowed to
 * burst up to the hourly cap on its first tick — capacity accrues from zero
 * over the configured window, the same as every tick after it.
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  const now = opts.now ?? (() => Date.now() / 1000);
  let messagesPerHour =
    opts.envMessagesPerHour > 0 ? opts.envMessagesPerHour : DEFAULT_MESSAGES_PER_HOUR;
  let tokens = 0;
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

  function reload(): void {
    if (!opts.configPath) {
      return;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(opts.configPath).mtimeMs;
    } catch {
      // Missing file — keep the previously effective rate rather than
      // falling back to the env/default value, which would look like a
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
      // Malformed JSON — keep the previously effective rate.
    }
  }

  return {
    tryTake() {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
    reload,
    currentRate() {
      return messagesPerHour;
    },
  };
}

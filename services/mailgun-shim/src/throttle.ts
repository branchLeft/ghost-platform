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
 * Token bucket in messages/hour. Starts with exactly ONE grace token, not a
 * full bucket and not zero.
 *
 * Not a full bucket: this gates warm-up sending, so a freshly started
 * worker must not be allowed to burst up to the hourly cap on its first
 * tick — capacity above the grace token accrues from zero over the
 * configured window, the same as every tick after it. A restart-to-bypass
 * attack is still bounded to one extra message per restart, which is a
 * much smaller bypass than the full hourly cap a truly full bucket would
 * hand out on every restart.
 *
 * Not zero either: at this component's own production default (50/hour),
 * a bucket starting at literally zero tokens makes the FIRST message ever
 * sent through a freshly started spool wait up to 72 seconds (1/50 hour)
 * for a token to accrue — before anything has actually burst, there is
 * nothing to protect against yet. That directly broke this story's own
 * Done criterion ("a message enqueued ... is handed over on a waiting
 * drain request within a second of enqueue") the first time it was
 * checked against production defaults rather than a test's boosted rate.
 * LLD-6 marks a *different* throttle — the demo-mail "two ceilings, not
 * one" containment in LLD-6 §05, load-bearing at §08 — but says nothing
 * about this one's cold-start latency, so fixing it is incidental: an
 * implementer's engineering call, not a redesign of anything LLD-6 pins.
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  const now = opts.now ?? (() => Date.now() / 1000);
  let messagesPerHour =
    opts.envMessagesPerHour > 0 ? opts.envMessagesPerHour : DEFAULT_MESSAGES_PER_HOUR;
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

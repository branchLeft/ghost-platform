import { resolveRecipientTokens } from './mailgunFields.js';
import { sendToRecipient, type Transporter } from './smtp.js';
import { SUPPRESSION_TYPES, type DueRecipient, type ShimStore } from './store.js';
import type { Logger } from './log.js';
import type { Throttle } from './throttle.js';

const TICK_INTERVAL_MS = 1000;
const CLAIM_BATCH_SIZE = 25;

// 6 total attempts, 5 backoff intervals between them — a transient failure
// on the 6th attempt is permanent, not a 6th wait.
const MAX_ATTEMPTS = 6;
const BACKOFF_LADDER_SECONDS = [60, 300, 900, 3600, 14400];

const CLEANUP_INTERVAL_SECONDS = 3600;
const COMPLETED_BATCH_RETENTION_SECONDS = 30 * 24 * 3600;

export interface WorkerOptions {
  store: ShimStore;
  transport: Transporter;
  throttle: Throttle;
  log: Logger;
  now?: () => number;
  tickIntervalMs?: number;
  claimBatchSize?: number;
}

export interface WorkerStatus {
  /** Epoch seconds the last tick completed, or null before the startup drain has finished once. */
  lastTickAt: number | null;
  stopped: boolean;
}

export interface WorkerHandle {
  /** Fire-and-forget nudge — safe to call without awaiting. */
  kick(): void;
  /** Resolves once the currently scheduled/running tick chain settles. Test-only determinism hook. */
  whenIdle(): Promise<void>;
  /** Stops claiming new work, finishes whatever send is in flight, then resolves. Does not close the store. */
  stop(): Promise<void>;
  /** Cheap liveness signal for /healthz — a store that answers pings but a worker that stopped ticking is a real degraded state neither store.ping() nor pending-count alone would show. */
  status(): WorkerStatus;
}

export function recipientDomain(address: string): string {
  const at = address.indexOf('@');
  return at === -1 ? 'unknown' : address.slice(at + 1);
}

function isTransientFailure(
  errorCode: number | undefined,
  errorMessage: string | undefined
): boolean {
  if (errorMessage === 'Invalid recipient address') {
    return false;
  }
  if (errorCode === undefined) {
    return true;
  }
  return errorCode >= 400 && errorCode < 500;
}

/**
 * Single in-process loop — the only writer to queue_recipients, so there is
 * no claim/lock race to design around. At-least-once, not exactly-once: a
 * crash between the SMTP transport accepting a message and this loop's
 * write of the "sent" row will re-send that one recipient on the next
 * startup drain. Bounded to one recipient per crash, accepted for a
 * single-instance relay.
 *
 * Sends strictly serially (one `await processRow` at a time), by design,
 * not oversight: every send is already throttle-gated immediately before
 * dispatch, so concurrency could never increase throughput past what the
 * throttle allows — it would only shrink wall-clock latency on a rare
 * catch-up burst. What it would cost is real: N concurrent in-flight sends
 * widens the at-least-once crash window from one possible duplicate to N.
 * Serial keeps that window at its documented minimum.
 */
export function createWorker(opts: WorkerOptions): WorkerHandle {
  const { store, transport, throttle, log } = opts;
  const now = opts.now ?? (() => Date.now() / 1000);
  const tickIntervalMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  const claimBatchSize = opts.claimBatchSize ?? CLAIM_BATCH_SIZE;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCleanupAt = 0;
  let lastTickAt: number | null = null;
  let runChain: Promise<void> = Promise.resolve();

  async function processRow(row: DueRecipient): Promise<void> {
    for (const type of SUPPRESSION_TYPES) {
      if (store.isSuppressed(row.domain, type, row.recipient)) {
        store.recordRecipientSuppressed(row.batchId, row.recipient);
        log.info('send_outcome', {
          batchId: row.batchId,
          emailId: row.emailId,
          outcome: 'suppressed',
          recipientDomain: recipientDomain(row.recipient),
        });
        return;
      }
    }

    const vars = row.payload.recipientVariables[row.recipient] ?? {};
    const resolvedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(row.payload.headers)) {
      if (name === 'Reply-To' || name === 'Sender') {
        continue;
      }
      resolvedHeaders[name] = resolveRecipientTokens(value, vars);
    }

    const result = await sendToRecipient(transport, {
      from: row.payload.from,
      to: row.recipient,
      toName: vars.name,
      subject: resolveRecipientTokens(row.payload.subject, vars),
      html: resolveRecipientTokens(row.payload.html, vars),
      text: resolveRecipientTokens(row.payload.text, vars),
      replyTo: row.payload.headers['Reply-To'],
      emailId: row.emailId ?? undefined,
      domain: row.domain,
      extraHeaders: resolvedHeaders,
    });

    const nowSeconds = now();

    if (result.ok) {
      store.recordRecipientSent(row.batchId, row.recipient, {
        domain: row.domain,
        type: 'delivered',
        severity: null,
        recipient: row.recipient,
        emailId: row.emailId,
        providerMessageId: result.providerMessageId,
        timestamp: nowSeconds,
        errorCode: null,
        errorMessage: null,
      });
      log.info('send_outcome', {
        batchId: row.batchId,
        emailId: row.emailId,
        outcome: 'sent',
        recipientDomain: recipientDomain(row.recipient),
      });
      return;
    }

    const newAttempts = row.attempts + 1;
    const transient = isTransientFailure(result.errorCode, result.errorMessage);

    if (!transient || newAttempts >= MAX_ATTEMPTS) {
      store.recordRecipientFailed(
        row.batchId,
        row.recipient,
        newAttempts,
        result.errorMessage ?? 'send failed',
        {
          domain: row.domain,
          type: 'failed',
          severity: 'permanent',
          recipient: row.recipient,
          emailId: row.emailId,
          providerMessageId: result.providerMessageId,
          timestamp: nowSeconds,
          errorCode: result.errorCode ?? null,
          errorMessage: result.errorMessage ?? null,
        }
      );
      log.info('send_outcome', {
        batchId: row.batchId,
        emailId: row.emailId,
        outcome: 'failed',
        errorCode: result.errorCode,
        recipientDomain: recipientDomain(row.recipient),
      });
      return;
    }

    const delaySeconds = BACKOFF_LADDER_SECONDS[newAttempts - 1] ?? BACKOFF_LADDER_SECONDS.at(-1)!;
    store.scheduleRecipientRetry(
      row.batchId,
      row.recipient,
      newAttempts,
      nowSeconds + delaySeconds,
      result.errorMessage ?? 'send failed'
    );
    log.info('send_outcome', {
      batchId: row.batchId,
      emailId: row.emailId,
      outcome: 'retry',
      errorCode: result.errorCode,
      attempts: newAttempts,
      recipientDomain: recipientDomain(row.recipient),
    });
  }

  function maybeCleanup(): void {
    const nowSeconds = now();
    if (nowSeconds - lastCleanupAt < CLEANUP_INTERVAL_SECONDS) {
      return;
    }
    lastCleanupAt = nowSeconds;
    const deleted = store.cleanupCompletedBatches(nowSeconds - COMPLETED_BATCH_RETENTION_SECONDS);
    if (deleted > 0) {
      log.info('queue_cleanup', { deletedBatches: deleted });
    }
  }

  async function runTick(): Promise<void> {
    throttle.reload();
    maybeCleanup();

    while (!stopped) {
      const due = store.claimDueRecipients(now(), claimBatchSize);
      if (due.length === 0) {
        break;
      }

      let throttled = false;
      for (const row of due) {
        if (stopped) {
          break;
        }
        if (!throttle.tryTake()) {
          throttled = true;
          break;
        }
        await processRow(row);
      }

      if (throttled || due.length < claimBatchSize) {
        break;
      }
    }

    lastTickAt = now();
  }

  function scheduleNextTick(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, tickIntervalMs);
    timer.unref?.();
  }

  function kick(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    runChain = runChain
      .then(() => runTick())
      .catch((err: unknown) => {
        log.error('worker_lifecycle', {
          event: 'tick_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .then(() => {
        scheduleNextTick();
      });
  }

  log.info('worker_lifecycle', { event: 'starting' });
  // Startup drain: process whatever is already due before the first
  // request arrives. This IS the crash-recovery path, not a separate one —
  // rows left pending by a crashed process look identical to rows that
  // simply haven't been claimed yet.
  kick();

  return {
    kick,
    whenIdle(): Promise<void> {
      return runChain;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await runChain;
      log.info('worker_lifecycle', { event: 'stopped' });
    },
    status(): WorkerStatus {
      return { lastTickAt, stopped };
    },
  };
}

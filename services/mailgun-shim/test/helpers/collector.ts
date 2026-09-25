import nodemailer, { type Transporter } from 'nodemailer';

/** The wire shape GET /drain hands back — see routes/drain.ts's own WireMessage. */
export interface DrainedWireMessage {
  id: string;
  domain: string;
  emailId: string | null;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  drainCount: number;
}

export interface CollectorOptions {
  shimBaseUrl: string;
  drainToken: string;
  /** Where "mx1" delivers to, standing in for the real delivery host. */
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  /**
   * Called with each drained message before it is acked — lets a test
   * simulate a collector that crashes between taking a batch and acking it
   * (throw here, or just never call ack, and the message stays held until
   * its lease lapses and is re-offered).
   */
  onDelivered?: (message: DrainedWireMessage) => void;
}

export interface Collector {
  deliveredIds: string[];
  /** One drain-and-ack pass: polls GET /drain once, delivers everything returned, acks everything delivered. Returns the ids acked this pass. */
  drainOnce(): Promise<string[]>;
  /** Runs drainOnce() in a loop, spaced by intervalMs, until stop() is called or the loop errors. */
  start(intervalMs?: number): void;
  stop(): void;
}

/**
 * The test-side stand-in for the mail collector (LLD-6 M3: mx1 or ops1
 * opens the drain connection, this shim only ever answers it). This
 * lives in test/, never src/ — the production collector is a separate
 * story's deliverable; this is only enough of one to prove the drain
 * contract end to end against a real delivery host.
 */
export function createCollector(opts: CollectorOptions): Collector {
  let transporter: Transporter | undefined;
  let running = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  const deliveredIds: string[] = [];

  function transport(): Transporter {
    transporter ??= nodemailer.createTransport({
      host: '127.0.0.1',
      port: opts.smtpPort,
      secure: false,
      auth: { user: opts.smtpUser, pass: opts.smtpPass },
    });
    return transporter;
  }

  async function drainOnce(): Promise<string[]> {
    const res = await fetch(`${opts.shimBaseUrl}/drain`, {
      headers: { Authorization: `Bearer ${opts.drainToken}` },
    });
    if (!res.ok) {
      throw new Error(`GET /drain failed: ${res.status}`);
    }
    const body = (await res.json()) as { messages: DrainedWireMessage[] };
    if (body.messages.length === 0) {
      return [];
    }

    const toAck: string[] = [];
    const acks: Array<{ id: string; drainCount: number }> = [];
    for (const message of body.messages) {
      await transport().sendMail({
        from: message.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });
      deliveredIds.push(message.id);
      opts.onDelivered?.(message);
      toAck.push(message.id);
      // The generation this message was handed over at — an ack must name
      // it, not just the id, so the store can tell a current claim from
      // one a lapsed-and-re-offered lease has since superseded (store.ts's
      // ackDrain doc explains why).
      acks.push({ id: message.id, drainCount: message.drainCount });
    }

    if (acks.length === 0) {
      return [];
    }

    const ackRes = await fetch(`${opts.shimBaseUrl}/drain/ack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.drainToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ acks }),
    });
    if (!ackRes.ok) {
      throw new Error(`POST /drain/ack failed: ${ackRes.status}`);
    }
    return toAck;
  }

  return {
    deliveredIds,
    drainOnce,
    start(intervalMs = 20) {
      running = true;
      const tick = (): void => {
        if (!running) {
          return;
        }
        drainOnce()
          .catch(() => {
            // Best-effort background loop — a transient failure here is
            // asserted on directly by tests that want it (via drainOnce()
            // itself), not by crashing the loop.
          })
          .finally(() => {
            if (running) {
              loopTimer = setTimeout(tick, intervalMs);
              loopTimer.unref?.();
            }
          });
      };
      tick();
    },
    stop() {
      running = false;
      if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
      }
    },
  };
}

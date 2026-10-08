import express from 'express';
import type { Server } from 'node:http';

export interface QueuedMessage {
  id: string;
  domain: string;
  emailId: string | null;
  from: string;
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
}

interface HeldRow extends QueuedMessage {
  drainCount: number;
  state: 'queued' | 'held';
}

/**
 * A real local HTTP server implementing the same wire contract as
 * `services/mailgun-shim/src/routes/drain.ts`, exercised over a real
 * socket rather than imported from the shim itself.
 * See ../../README.md#fakeshimserver-fakeshimserver.
 */
export class FakeShimServer {
  private rows = new Map<string, HeldRow>();
  private nextDrainCount = 1;
  private server: Server | undefined;
  readonly drainRequests: number[] = [];
  readonly ackRequests: Array<{ id: string; drainCount: number }[]> = [];
  /** Every POST /drain/outcomes body's list, in order. */
  readonly outcomeRequests: Array<Array<Record<string, unknown>>> = [];
  /** Off by default, like the real shim: POST /drain/outcomes then answers 404. */
  outcomesEnabled = false;

  constructor(private readonly drainToken: string) {}

  enqueue(message: QueuedMessage): void {
    this.rows.set(message.id, { ...message, drainCount: 0, state: 'queued' });
  }

  /** Forces every currently-held row back to queued under a fresh drainCount, as if its lease had lapsed with no ack received. */
  simulateLostAck(): void {
    for (const row of this.rows.values()) {
      if (row.state === 'held') {
        row.state = 'queued';
        row.drainCount += 1;
      }
    }
  }

  /** `port` defaults to 0 (an OS-assigned free port); pass a fixed one only when a test needs to name it ahead of time, e.g. to match a descriptor's configured shim port. */
  async listen(port = 0): Promise<string> {
    const app = express();
    app.disable('x-powered-by');

    const requireAuth = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): void => {
      const header = req.headers.authorization;
      if (header !== `Bearer ${this.drainToken}`) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      next();
    };

    app.get('/drain', requireAuth, (_req, res) => {
      this.drainRequests.push(Date.now());
      const messages = [];
      for (const row of this.rows.values()) {
        if (row.state === 'queued') {
          row.state = 'held';
          row.drainCount = this.nextDrainCount++;
          const { state, ...wire } = row;
          void state;
          messages.push(wire);
        }
      }
      res.status(200).json({ messages });
    });

    app.post('/drain/ack', requireAuth, express.json(), (req, res) => {
      const acks = (req.body as { acks: Array<{ id: string; drainCount: number }> }).acks;
      this.ackRequests.push(acks);
      const acked: string[] = [];
      const alreadyHandled: string[] = [];
      const unknown: string[] = [];
      for (const ack of acks) {
        const row = this.rows.get(ack.id);
        if (!row) {
          unknown.push(ack.id);
        } else if (row.state === 'held' && row.drainCount === ack.drainCount) {
          this.rows.delete(ack.id);
          acked.push(ack.id);
        } else if (!this.rows.has(ack.id)) {
          alreadyHandled.push(ack.id);
        } else {
          unknown.push(ack.id);
        }
      }
      res.status(200).json({ acked, alreadyHandled, unknown });
    });

    app.post('/drain/outcomes', requireAuth, express.json(), (req, res) => {
      if (!this.outcomesEnabled) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      const outcomes = (req.body as { outcomes: Array<Record<string, unknown>> }).outcomes;
      this.outcomeRequests.push(outcomes);
      res.status(200).json({
        recorded: outcomes.map((o) => o.id),
        alreadyHandled: [],
        unknown: [],
      });
    });

    return new Promise((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => {
        this.server = server;
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind fake shim server'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
      server.on('error', reject);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}

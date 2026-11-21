import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface FakeComplaint {
  seq: number;
  outcomeId: string;
  class: string;
  at: number;
}

/**
 * A real local HTTP server with the same two drain routes as
 * `services/sweego-webhook-receiver/src/drain.ts`, driven over a real socket.
 * Nothing is imported from that package: the collector is proven against the
 * wire contract, not against shared code.
 */
export class FakeComplaintReceiver {
  private server: Server | undefined;
  private records: FakeComplaint[] = [];
  private nextSeq = 1;
  private acked = 0;
  /** Every `through` value acknowledged, in order. */
  readonly ackRequests: number[] = [];
  /** Authorization headers seen, for the token tests. */
  readonly authHeaders: Array<string | undefined> = [];
  /** Answer every request with this status instead of serving it; 0 serves normally. */
  failWith = 0;
  /** Fail only acknowledgements. */
  failAck = false;

  constructor(private readonly token: string) {}

  /** Queues a verified complaint, as the receiver does after a signed webhook. */
  enqueue(outcomeId: string, cls = 'spam', at = Math.floor(Date.now() / 1000)): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.records.push({ seq, outcomeId, class: cls, at });
    return seq;
  }

  /** Records the receiver still holds. */
  get queued(): readonly FakeComplaint[] {
    return this.records;
  }

  get ackedThrough(): number {
    return this.acked;
  }

  async listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, (status, body) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind fake receiver'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  private handle(req: IncomingMessage, reply: (status: number, body: unknown) => void): void {
    this.authHeaders.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      reply(401, { message: 'Unauthorized' });
      return;
    }
    if (this.failWith !== 0) {
      reply(this.failWith, { message: 'down' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://drain.invalid');
    if (url.pathname === '/drain' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? this.acked);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      reply(200, { records: this.records.filter((r) => r.seq > after).slice(0, limit) });
      return;
    }
    if (url.pathname === '/drain/ack' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (this.failAck) {
          reply(503, { message: 'Unavailable' });
          return;
        }
        const through = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { through: number })
          .through;
        this.ackRequests.push(through);
        const before = this.records.length;
        this.records = this.records.filter((r) => r.seq > through);
        this.acked = Math.max(this.acked, through);
        reply(200, { removed: before - this.records.length });
      });
      return;
    }
    reply(404, { message: 'Not found' });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

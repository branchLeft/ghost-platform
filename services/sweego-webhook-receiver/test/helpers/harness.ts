import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/log.js';
import { openQueue, type Queue } from '../../src/queue.js';
import { openReplayStore, type ReplayStore } from '../../src/replay.js';
import { createStats, type Stats } from '../../src/stats.js';
import { createWebhookServer } from '../../src/webhook.js';

export const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);
export const SECRET_A = Buffer.from('SECRET_A_PLACEHOLDER_BYTES_0123456789');
export const SECRET_B = Buffer.from('SECRET_B_PLACEHOLDER_BYTES_0123456789');

export interface Harness {
  dir: string;
  queue: Queue;
  replay: ReplayStore;
  stats: Stats;
  clock: { ms: number };
  server: Server;
  port: number;
  close(): Promise<void>;
}

export interface HarnessOptions {
  secrets?: Buffer[];
  maxBodyBytes?: number;
  queueMaxBytes?: number;
  outcomeHeader?: string;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'swh-'));
  const clock = { ms: NOW_MS };
  const queue = openQueue(dir, options.queueMaxBytes);
  const replay = openReplayStore(dir, () => clock.ms);
  const stats = createStats();
  const server = createWebhookServer(
    {
      secrets: options.secrets ?? [SECRET_A],
      queue,
      replay,
      stats,
      now: () => clock.ms,
      log: createLogger(() => undefined),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.outcomeHeader === undefined ? {} : { outcomeHeader: options.outcomeHeader }),
    },
    {
      headersTimeoutMs: options.headersTimeoutMs ?? 5000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10000,
      keepAliveTimeoutMs: 2000,
      checkIntervalMs: 50,
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const harness: Harness = {
    dir,
    queue,
    replay,
    stats,
    clock,
    server,
    port: (server.address() as AddressInfo).port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const closeable of [harness.queue, harness.replay]) {
        try {
          closeable.close();
        } catch {
          // already closed by the test that is finishing
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function sign(secret: Buffer, id: string, timestamp: string, body: string | Buffer): string {
  const payload = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), Buffer.from(body)]);
  return createHmac('sha256', secret).update(payload).digest('base64');
}

export function complaintBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: 'complaint',
    event_id: 'EVENT_ID_PLACEHOLDER_1',
    swg_uid: 'SWG_UID_PLACEHOLDER_1',
    reason: 'abuse',
    recipient: 'RECIPIENT_PLACEHOLDER@example.invalid',
    ...overrides,
  });
}

export interface SignedOptions {
  id?: string;
  timestamp?: string;
  secret?: Buffer;
  signatureHeader?: string | null;
  headers?: Record<string, string>;
}

export function signedHeaders(
  body: string | Buffer,
  options: SignedOptions = {}
): Record<string, string> {
  const id = options.id ?? 'WEBHOOK_ID_PLACEHOLDER_1';
  const timestamp = options.timestamp ?? String(NOW_S);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    ...options.headers,
  };
  if (options.signatureHeader !== null) {
    headers['webhook-signature'] =
      options.signatureHeader ?? `v1,${sign(options.secret ?? SECRET_A, id, timestamp, body)}`;
  }
  return headers;
}

export interface Reply {
  status: number;
  body: string;
}

export function send(
  port: number,
  method: string,
  path: string,
  body: string | Buffer | undefined,
  headers: Record<string, string>
): Promise<Reply> {
  const lengthed =
    body !== undefined && !('content-length' in headers) && !('transfer-encoding' in headers)
      ? { ...headers, 'content-length': String(Buffer.byteLength(body)) }
      : headers;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: lengthed, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

export function postSigned(
  h: Harness,
  body: string | Buffer,
  options: SignedOptions = {}
): Promise<Reply> {
  return send(h.port, 'POST', '/webhook', body, signedHeaders(body, options));
}

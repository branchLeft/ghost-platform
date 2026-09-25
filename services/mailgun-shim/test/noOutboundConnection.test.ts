import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDrainWake } from '../src/drainWake.js';
import { createSqliteStore, type ShimStore } from '../src/store.js';
import { createUnlimitedThrottle } from './helpers/testThrottle.js';

/**
 * The story's own Done sentence: "A test asserts the spool makes no
 * outbound connection, and it is proven by sabotage: restore the old
 * delivery worker and the test goes red."
 *
 * This patches the one primitive every TCP client in Node bottoms out on
 * — net.Socket#connect (nodemailer's SMTP transport included: it is built
 * on net.connect/tls.connect, both of which construct a Socket and call
 * this method) — so it catches an outbound dial regardless of which
 * library made it, not just the specific worker.ts/smtp.ts shape this
 * story deleted. The test's own HTTP client (`fetch`, against the shim's
 * own loopback port) necessarily also goes through this method, so calls
 * targeting the shim's own bound port are the expected baseline; anything
 * else is exactly what "no outbound connection" means here.
 */
type ConnectAttempt = { host: string | undefined; port: number | undefined };

function extractTarget(args: any[]): ConnectAttempt {
  let first: unknown = args[0];
  // Node's own Socket#connect normalizes its overloaded arguments
  // (options object; port+host; a Unix socket path — each with an
  // optional trailing callback) into a single `[options, callback]` array
  // tagged with an internal `normalizedArgsSymbol`, and a caller already
  // holding one of those (as a recursive internal call does) passes that
  // array straight through as args[0] rather than re-spreading it —
  // verified empirically against this exact nodemailer/Node version by
  // logging args[0] here, not assumed from documentation. Unwrap it if
  // present so both shapes resolve to the same target.
  if (Array.isArray(first)) {
    first = first[0];
  }
  if (first && typeof first === 'object') {
    const opts = first as { host?: string; port?: number; path?: string };
    return { host: opts.host ?? (opts.path ? `unix:${opts.path}` : undefined), port: opts.port };
  }
  if (typeof first === 'number') {
    return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first };
  }
  return { host: typeof first === 'string' ? first : undefined, port: undefined };
}

function recordConnectAttempts(): { attempts: ConnectAttempt[]; restore: () => void } {
  const attempts: ConnectAttempt[] = [];
  const original = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: any[]) {
    attempts.push(extractTarget(args));
    return (original as any).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  return {
    attempts,
    restore() {
      net.Socket.prototype.connect = original;
    },
  };
}

describe('the spool makes no outbound connection', () => {
  let store: ShimStore;
  let server: Server;
  let baseUrl: string;
  let appPort: number;

  beforeEach(async () => {
    store = createSqliteStore(':memory:');
    const wake = createDrainWake();
    const app = createApp(
      store,
      wake,
      'test-drain-token',
      { holdMs: 50, leaseSeconds: 30, batchLimit: 25, pollIntervalMs: 10 },
      createUnlimitedThrottle()
    );
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    appPort = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${appPort}`;
    store.registerTenant('tenant1.example.com', 'the-api-key');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  it("opens no socket other than the ones the test's own HTTP client makes to the shim's own port, across a full enqueue -> drain -> ack -> metrics cycle", async () => {
    const { attempts, restore } = recordConnectAttempts();
    try {
      const form = new FormData();
      form.append('to', 'member@example.com');
      form.append('from', 'noreply@tenant1.example.com');
      form.append('subject', 'Hi');
      form.append('html', '<p>hi</p>');
      form.append('text', 'hi');
      form.append('recipient-variables', '{}');

      await fetch(`${baseUrl}/v3/tenant1.example.com/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from('api:the-api-key').toString('base64')}` },
        body: form,
      });

      const drainRes = await fetch(`${baseUrl}/drain`, {
        headers: { Authorization: 'Bearer test-drain-token' },
      });
      const drainBody = (await drainRes.json()) as { messages: Array<{ id: string }> };
      expect(drainBody.messages).toHaveLength(1);

      await fetch(`${baseUrl}/drain/ack`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-drain-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [drainBody.messages[0]!.id] }),
      });

      await fetch(`${baseUrl}/healthz`);
      await fetch(`${baseUrl}/metrics`);

      // Every connect() the test observed is either unattributable to a
      // real host (undici's own internal bookkeeping) or targets the
      // shim's own loopback port — i.e. it is the test's own client
      // reaching the server under test, never the server reaching
      // anywhere else. Port arrives as a string from undici's own
      // internal connect call (verified above), so compare numerically.
      const unexpected = attempts.filter((a) => a.port !== undefined && Number(a.port) !== appPort);
      expect(unexpected).toEqual([]);
    } finally {
      restore();
    }
  });

  it('the same guard catches an outbound SMTP dial — the exact shape the deleted worker.ts/smtp.ts made — if application code attempted one', async () => {
    // Not a mock of the old worker: nodemailer is the literal library
    // smtp.ts built its transport on (see git history at this story's
    // parent commit), so driving a real nodemailer transport here
    // exercises the identical connect() call the deleted code made.
    const nodemailer = await import('nodemailer');
    const { attempts, restore } = recordConnectAttempts();
    try {
      const transport = nodemailer.createTransport({
        host: '203.0.113.1', // TEST-NET-3 (RFC 5737) — reserved, never routable, so this never actually completes a handshake; connect() is still invoked before that failure.
        port: 25,
        connectionTimeout: 200,
        greetingTimeout: 200,
        socketTimeout: 200,
      });
      await transport
        .sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'x' })
        .catch(() => {
          // Expected: the address is unroutable. The point is the attempt, not the outcome.
        });

      const unexpected = attempts.filter((a) => a.port !== undefined && a.port !== appPort);
      expect(unexpected.length).toBeGreaterThan(0);
      expect(unexpected.some((a) => a.host === '203.0.113.1')).toBe(true);
    } finally {
      restore();
    }
  }, 5000);
});

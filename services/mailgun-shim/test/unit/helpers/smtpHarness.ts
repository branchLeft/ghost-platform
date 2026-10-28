import { Socket } from 'node:net';
import {
  createSmtpFrontDoor,
  DEFAULT_ALLOWED_SOURCE_CIDRS,
  type SmtpFrontDoor,
  type SmtpFrontDoorOptions,
} from '../../../src/smtpFrontDoor.js';
import { createSqliteStore, type ShimStore } from '../../../src/store.js';
import { createDrainWake } from '../../../src/drainWake.js';
import { createTestLogger } from '../../helpers/testLogger.js';

/** A real SMTP front door over a real store, listening on an ephemeral loopback port. */
export interface Harness {
  store: ShimStore;
  frontDoor: SmtpFrontDoor;
  port: number;
  close(): Promise<void>;
}

/** Each tenant is `[domain, apiKey]`; its sender domain is its domain. */
export async function startHarness(
  tenants: ReadonlyArray<readonly [string, string]>,
  overrides: Partial<SmtpFrontDoorOptions> = {}
): Promise<Harness> {
  const store = createSqliteStore(':memory:');
  for (const [domain, key] of tenants) {
    store.registerTenant(domain, key, domain);
  }
  const { logger } = createTestLogger();
  const frontDoor = createSmtpFrontDoor({
    store,
    wake: createDrainWake(),
    log: logger,
    maxMessageBytes: 1024 * 1024,
    maxRecipientsPerMessage: 50,
    maxUnauthenticatedConnectionsPerSource: 20,
    maxUnauthenticatedConnections: 20,
    maxUnauthenticatedPerSourceWaitQueueDepth: 50,
    maxUnauthenticatedPerSourceWaitMs: 2000,
    authDeadlineMs: 5000,
    maxConcurrentDataPhases: 20,
    maxConcurrentDataPhasesPerSubmitter: 5,
    allowedSourceCidrs: DEFAULT_ALLOWED_SOURCE_CIDRS,
    submitterMessagesPerMinute: 120,
    ...overrides,
  });
  const port = await frontDoor.listen(0, '127.0.0.1');
  return {
    store,
    frontDoor,
    port,
    async close() {
      await frontDoor.close();
      store.close();
    },
  };
}

/** A raw protocol script: each line is sent after the previous reply arrives. Returns every final reply line. */
export function rawSmtpCommands(port: number, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const responses: string[] = [];
    let buffer = '';
    let step = 0;

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\r\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line === '') continue;
        if (/^\d{3}-/.test(line)) continue;
        responses.push(line);
        if (step < lines.length) {
          socket.write(lines[step] + '\r\n');
          step += 1;
        } else {
          socket.end();
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(responses));
    socket.connect(port, '127.0.0.1');
  });
}

export function authPlain(user: string, key: string): string {
  return Buffer.from(`\u0000${user}\u0000${key}`).toString('base64');
}

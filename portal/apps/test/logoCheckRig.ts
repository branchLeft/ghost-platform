import { fileURLToPath } from 'node:url';
import type { LogoVerdictSource } from '../src/frontdoor/logoCheck.js';

/**
 * The safety-service client and its fake transport live in the scanning
 * adapter, a plain JavaScript package outside this one. They are loaded by
 * path at run time, so the type check does not follow them, and described here
 * by the part this suite uses.
 */
const ADAPTER = fileURLToPath(new URL('../../../adapters/scanning-storage/', import.meta.url));

export interface Answer {
  readonly classification?: unknown;
  readonly key?: unknown;
  readonly evidence?: unknown;
}

export interface TransportRecord {
  connects: number;
  asked: string[];
  closed: number;
}

export interface FakeTransport {
  readonly transport: unknown;
  readonly record: TransportRecord;
}

interface TransportModule {
  fakeTransport(options?: {
    connect?: () => Promise<unknown>;
    ask?: (key: string) => unknown;
    echoKey?: boolean;
  }): FakeTransport;
  NEVER: () => Promise<never>;
}

interface ClientModule {
  ProductionVerdictClient: new (options: {
    transport: unknown;
    connectTimeoutMs?: number;
    totalTimeoutMs?: number;
  }) => LogoVerdictSource;
}

export async function loadAdapter(): Promise<{
  readonly fakeTransport: TransportModule['fakeTransport'];
  readonly NEVER: TransportModule['NEVER'];
  readonly client: (transport: unknown) => LogoVerdictSource;
}> {
  const helper = `${ADAPTER}test/helpers/fake-verdict-transport.mjs`;
  const source = `${ADAPTER}src/production-verdict-client.js`;
  const transports = (await import(/* @vite-ignore */ helper)) as TransportModule;
  const loaded = (await import(/* @vite-ignore */ source)) as ClientModule & {
    default?: ClientModule;
  };
  const Client = (loaded.ProductionVerdictClient ?? loaded.default?.ProductionVerdictClient)!;
  return {
    fakeTransport: transports.fakeTransport,
    NEVER: transports.NEVER,
    // Budgets well under a test's own: a hold must arrive quickly.
    client: (transport) => new Client({ transport, connectTimeoutMs: 50, totalTimeoutMs: 100 }),
  };
}

/** A stand-in for the demo request table: a row exists only if the write ran. */
export class RowStore {
  readonly rows: Array<{ logoHash: string | undefined }> = [];

  readonly write = (logoHash: string | undefined): Promise<string> => {
    this.rows.push({ logoHash });
    return Promise.resolve('written');
  };
}

export const LOGO = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

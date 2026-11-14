import type { AddressInfo } from 'node:net';
import { createClient, createConfig, type Client } from '../../src/generated/client/index.js';
import { createMock, type Mock, type MockOptions } from '../../mock/server.js';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const TENANT_A_CREDENTIAL = 'TEST_TENANT_A_CREDENTIAL';
export const TENANT_B_CREDENTIAL = 'TEST_TENANT_B_CREDENTIAL';
export const OWNER_CREDENTIAL = 'TEST_OWNER_CREDENTIAL';

export interface RunningMock {
  readonly baseUrl: string;
  readonly mock: Mock;
  /** Everything the generated server turned into a 500. */
  readonly errors: unknown[];
  readonly close: () => Promise<void>;
}

/** Serves the mock on an ephemeral loopback port. */
export async function startMock(overrides: Partial<MockOptions> = {}): Promise<RunningMock> {
  let counter = 0;
  const errors: unknown[] = [];
  const mock = createMock({
    credentials: {
      owner: OWNER_CREDENTIAL,
      tenants: new Map([
        [TENANT_A_CREDENTIAL, TENANT_A],
        [TENANT_B_CREDENTIAL, TENANT_B],
      ]),
    },
    tenants: [TENANT_A, TENANT_B],
    newId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const { port } = mock.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    mock,
    errors,
    close: () =>
      new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error === undefined ? resolve() : reject(error)));
        mock.server.closeAllConnections();
      }),
  };
}

/** A generated client that presents `credential` for whichever scheme an operation names. */
export function clientWith(baseUrl: string, credential: string | undefined): Client {
  return createClient(
    createConfig({
      baseUrl,
      auth: () => credential,
      throwOnError: false,
    })
  );
}

/** A plain request, for what the generated client would not send. */
export async function raw(
  baseUrl: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; contentType: string | null; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options.headers ?? {},
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    json: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AddressInfo } from 'node:net';
import {
  createMock,
  type Mock,
} from '../../../services/provisioning-controller/dist/mock/server.js';
import type { ProvisioningSettings } from '../src/tenant/provisioningSettings.js';

/**
 * The provisioning API's in-memory mock, served through the generated server,
 * for the screens' tests. The mock is imported here and nowhere in `src`.
 */
export const OWNER_CREDENTIAL = 'TEST_OWNER_CREDENTIAL';
export const CREDENTIAL_A = 'TEST_TENANT_A_CREDENTIAL';
export const CREDENTIAL_B = 'TEST_TENANT_B_CREDENTIAL';

export interface RunningApi {
  readonly baseUrl: string;
  readonly mock: Mock;
  /** Everything the generated server turned into a 500. */
  readonly errors: unknown[];
  close(): Promise<void>;
}

export async function startApi(tenantA: string, tenantB: string, seeded: readonly string[]) {
  const errors: unknown[] = [];
  let counter = 0;
  const mock = createMock({
    credentials: {
      owner: OWNER_CREDENTIAL,
      tenants: new Map([
        [CREDENTIAL_A, tenantA],
        [CREDENTIAL_B, tenantB],
      ]),
    },
    tenants: seeded,
    newId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    onError: (error) => errors.push(error),
  });
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const { port } = mock.server.address() as AddressInfo;
  const running: RunningApi = {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    mock,
    errors,
    close: () =>
      new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error === undefined ? resolve() : reject(error)));
        mock.server.closeAllConnections();
      }),
  };
  return running;
}

/** The credentials the portal would hold, one per tenant. */
export function settingsFor(
  baseUrl: string,
  credentials: Readonly<Record<string, string>>,
  fetchOverride?: typeof fetch
): ProvisioningSettings {
  return {
    baseUrl,
    credentialFor: (tenant) => credentials[tenant],
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
  };
}

/** The request a test's HTTP wrapper is serving, for a sabotaged screen to (wrongly) read. */
export const ambientRequestUrl = new AsyncLocalStorage<string>();

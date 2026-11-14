import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createContractListener } from '../src/generated/server.js';
import { createMockHandlers } from './handlers.js';
import type { Credentials } from './auth.js';
import { MockStore, type StoreOptions } from './store.js';

export interface MockOptions extends StoreOptions {
  readonly credentials: Credentials;
  /** Tenants that start with a `LIVE` demo. */
  readonly tenants: readonly string[];
  /** Called with whatever the generated server turns into a 500 (a response the spec forbids, for one). */
  readonly onError?: (error: unknown) => void;
}

export interface Mock {
  readonly server: Server;
  readonly store: MockStore;
}

/** The generated server over the mock's handlers; the caller says where to listen. */
export function createMock(options: MockOptions): Mock {
  const store = new MockStore(options);
  for (const tenant of options.tenants) store.seedDemoTenant(tenant);
  const listener = createContractListener(createMockHandlers(store, options.credentials), {
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { server: createHttpServer(listener), store };
}

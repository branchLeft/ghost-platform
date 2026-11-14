import type { Credentials } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class MockConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockConfigError';
  }
}

export interface MockConfig {
  readonly port: number;
  readonly host: string;
  readonly credentials: Credentials;
  readonly tenants: readonly string[];
}

/**
 * MOCK_OWNER_CREDENTIAL: the owner console's credential.
 * MOCK_TENANT_CREDENTIALS: comma-separated `<tenant id>=<credential>` pairs,
 * one per tenant that should start with a demo.
 * PORT (default 8095) and LISTEN_HOST (default 127.0.0.1) say where to listen.
 * The mock refuses to start without a credential rather than invent one.
 */
export function readConfig(env: Readonly<Record<string, string | undefined>>): MockConfig {
  const owner = env.MOCK_OWNER_CREDENTIAL;
  if (owner === undefined || owner === '') {
    throw new MockConfigError('MOCK_OWNER_CREDENTIAL is not set');
  }
  const raw = env.MOCK_TENANT_CREDENTIALS;
  if (raw === undefined || raw === '') {
    throw new MockConfigError('MOCK_TENANT_CREDENTIALS is not set');
  }
  const tenants = new Map<string, string>();
  const ids: string[] = [];
  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=');
    const id = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (at < 0 || !UUID.test(id) || value === '') {
      throw new MockConfigError(
        'MOCK_TENANT_CREDENTIALS must be comma-separated <tenant uuid>=<credential> pairs'
      );
    }
    if (value === owner || tenants.has(value) || ids.includes(id)) {
      throw new MockConfigError('each credential and each tenant must appear once, and differ');
    }
    tenants.set(value, id);
    ids.push(id);
  }
  const port = Number(env.PORT ?? '8095');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new MockConfigError('PORT is not a port number');
  }
  return {
    port,
    host: env.LISTEN_HOST ?? '127.0.0.1',
    credentials: { owner, tenants },
    tenants: ids,
  };
}

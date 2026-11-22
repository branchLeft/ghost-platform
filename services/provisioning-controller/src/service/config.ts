import { isAbsolute } from 'node:path';

export class ServiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceConfigError';
  }
}

export interface ServiceConfig {
  readonly port: number;
  readonly host: string;
  /** A file holding the owner console's credential. */
  readonly ownerCredentialFile: string;
  /** A file of lines `<tenant uuid>=<credential>`, one per tenant. */
  readonly tenantCredentialsFile: string;
  /** The register of demos: which tenants exist and where their demo stands. */
  readonly demosFile: string;
  /** Where the service writes its state and the approval ledger. */
  readonly stateDir: string;
}

const FILE_VARIABLES = {
  ownerCredentialFile: 'PROVISIONING_OWNER_CREDENTIAL_FILE',
  tenantCredentialsFile: 'PROVISIONING_TENANT_CREDENTIALS_FILE',
  demosFile: 'PROVISIONING_DEMOS_FILE',
  stateDir: 'PROVISIONING_STATE_DIR',
} as const;

function pathFrom(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new ServiceConfigError(`${name} is absent`);
  if (!isAbsolute(value)) throw new ServiceConfigError(`${name} must be an absolute path`);
  return value;
}

/**
 * Four paths, a port and a listen address. The credentials are named by file
 * and never by value, so none is in the environment, a log or an error. The
 * default listen address is loopback: a deployment that wants the container's
 * network says so in `LISTEN_HOST`.
 */
export function readServiceConfig(
  env: Readonly<Record<string, string | undefined>>
): ServiceConfig {
  const port = Number(env['PORT'] ?? '8095');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ServiceConfigError('PORT is not a port number');
  }
  return {
    port,
    host: env['LISTEN_HOST'] ?? '127.0.0.1',
    ownerCredentialFile: pathFrom(env, FILE_VARIABLES.ownerCredentialFile),
    tenantCredentialsFile: pathFrom(env, FILE_VARIABLES.tenantCredentialsFile),
    demosFile: pathFrom(env, FILE_VARIABLES.demosFile),
    stateDir: pathFrom(env, FILE_VARIABLES.stateDir),
  };
}

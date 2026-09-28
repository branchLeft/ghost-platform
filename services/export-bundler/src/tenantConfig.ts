import { execFile } from 'node:child_process';
import { assertAgeRecipient } from './ageEncryption.js';

/**
 * Everything that decides whose data is exported, as whom, and to which
 * key comes from the tenant's own rendered configuration, never from a
 * value the operator types:
 *
 * - the Ghost environment, image, user and volumes from the tenant's
 *   rendered `compose.yml`, resolved by `docker compose config` against its
 *   secrets and image env files, so the export colour boots exactly as the
 *   tenant's own colours do;
 * - the support identity from that same environment -- the one the
 *   tenant's break-glass adapter is configured with;
 * - the `age` recipient from the tenant descriptor's
 *   `backup.encryptionRecipient`, the one recipient its backups use.
 */

export class TenantConfigError extends Error {
  constructor(message: string) {
    super(`refused: ${message}; nothing was started`);
    this.name = 'TenantConfigError';
  }
}

export class RecipientMismatchError extends Error {
  constructor() {
    super(
      "refused: --age-recipient is not this tenant's backup.encryptionRecipient; nothing was started"
    );
    this.name = 'RecipientMismatchError';
  }
}

export const SUPPORT_IDENTITY_ENV = 'adapters__sso__BreakGlassSSO__supportIdentity';
export const BREAK_GLASS_TENANT_ENV = 'adapters__sso__BreakGlassSSO__tenant';
/** Both colours render the same environment; the export boots as colour a. */
export const SOURCE_SERVICE = 'ghost-a';

export interface TenantVolume {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface TenantRuntime {
  readonly stackName: string;
  readonly image: string;
  readonly user: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: readonly TenantVolume[];
  readonly supportIdentity: string;
}

export interface DescriptorFacts {
  readonly slug: string;
  readonly ageRecipient: string;
  /** Present once the descriptor carries a break-glass triple. */
  readonly supportIdentity: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TenantConfigError(`${where}.${key} is missing or not a string`);
  }
  return value;
}

/** The output of `docker compose config --format json` for the tenant's stack. */
export function parseComposeConfig(config: unknown): TenantRuntime {
  if (!isRecord(config)) throw new TenantConfigError('the compose config is not an object');
  const stackName = stringField(config, 'name', 'compose');
  const services = config.services;
  const service = isRecord(services) ? services[SOURCE_SERVICE] : undefined;
  if (!isRecord(service)) {
    throw new TenantConfigError(`the compose stack has no ${SOURCE_SERVICE} service`);
  }
  const image = stringField(service, 'image', SOURCE_SERVICE);
  const user = typeof service.user === 'string' && service.user.length > 0 ? service.user : null;

  const rawEnv = isRecord(service.environment) ? service.environment : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value === null || value === undefined) continue;
    env[key] = String(value);
  }

  const volumes: TenantVolume[] = [];
  for (const entry of Array.isArray(service.volumes) ? service.volumes : []) {
    if (!isRecord(entry) || entry.type !== 'volume') {
      throw new TenantConfigError(`${SOURCE_SERVICE} mounts something other than a named volume`);
    }
    volumes.push({
      source: stringField(entry, 'source', `${SOURCE_SERVICE}.volumes`),
      target: stringField(entry, 'target', `${SOURCE_SERVICE}.volumes`),
      readOnly: entry.read_only === true,
    });
  }
  if (volumes.length === 0) throw new TenantConfigError(`${SOURCE_SERVICE} mounts no volume`);

  const supportIdentity = env[SUPPORT_IDENTITY_ENV];
  if (!supportIdentity) {
    throw new TenantConfigError(
      `the tenant's rendered environment has no ${SUPPORT_IDENTITY_ENV}: break-glass is not configured for it`
    );
  }
  return { stackName, image, user, env, volumes, supportIdentity };
}

/** The fields of a tenant descriptor this package binds to. */
export function parseDescriptorFacts(descriptor: unknown): DescriptorFacts {
  if (!isRecord(descriptor)) throw new TenantConfigError('the descriptor is not an object');
  const slug = stringField(descriptor, 'slug', 'descriptor');
  const backup = descriptor.backup;
  if (!isRecord(backup) || backup.kind !== 'bucket-native') {
    throw new TenantConfigError(
      "the descriptor's backup.kind is not bucket-native, so the tenant has no encryption recipient"
    );
  }
  const ageRecipient = stringField(backup, 'encryptionRecipient', 'descriptor.backup');
  try {
    assertAgeRecipient(ageRecipient);
  } catch {
    throw new TenantConfigError(
      "the descriptor's backup.encryptionRecipient is not an age recipient"
    );
  }
  let supportIdentity: string | null = null;
  const breakGlass = descriptor.breakGlass;
  if (isRecord(breakGlass) && breakGlass.kind === 'enabled') {
    supportIdentity = stringField(breakGlass, 'supportIdentity', 'descriptor.breakGlass');
  }
  return { slug, ageRecipient, supportIdentity };
}

/**
 * Cross-checks the descriptor, the rendered stack and the operator's
 * stated recipient, and returns the recipient the archive is encrypted to.
 */
export function bindTenant(
  descriptor: DescriptorFacts,
  runtime: TenantRuntime,
  operatorRecipient: string
): string {
  if (runtime.stackName !== descriptor.slug) {
    throw new TenantConfigError(
      `the compose stack is "${runtime.stackName}", not the descriptor's "${descriptor.slug}"`
    );
  }
  const adapterTenant = runtime.env[BREAK_GLASS_TENANT_ENV];
  if (adapterTenant !== descriptor.slug) {
    throw new TenantConfigError(
      `the rendered ${BREAK_GLASS_TENANT_ENV} does not name the descriptor's tenant`
    );
  }
  if (
    descriptor.supportIdentity !== null &&
    descriptor.supportIdentity !== runtime.supportIdentity
  ) {
    throw new TenantConfigError(
      "the rendered support identity is not the descriptor's breakGlass.supportIdentity"
    );
  }
  if (operatorRecipient !== descriptor.ageRecipient) throw new RecipientMismatchError();
  return descriptor.ageRecipient;
}

export interface ComposeSource {
  readonly composeFile: string;
  readonly envFiles: readonly string[];
}

export function buildComposeConfigArgs(source: ComposeSource): readonly string[] {
  const args = ['compose', '-f', source.composeFile];
  for (const envFile of source.envFiles) args.push('--env-file', envFile);
  args.push('config', '--format', 'json');
  return args;
}

/**
 * Resolves the stack with Compose's own interpolation. The child gets PATH
 * only, so nothing from the operator's environment can fill a `${VAR}` the
 * tenant's own env files do not.
 */
export function loadComposeConfig(
  source: ComposeSource,
  dockerCommand = 'docker'
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerCommand,
      [...buildComposeConfigArgs(source)],
      { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new TenantConfigError(
              `docker compose config exited ${String(err.code)}: ${stderr.slice(0, 500)}`
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new TenantConfigError('docker compose config printed something other than JSON'));
        }
      }
    );
  });
}
